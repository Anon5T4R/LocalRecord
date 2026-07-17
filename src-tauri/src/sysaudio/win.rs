//! Caminho Windows do áudio do sistema: WASAPI loopback (crate `windows`, em
//! POLLING) → named pipe → ffmpeg. O PORQUÊ de cada escolha está no topo do
//! `sysaudio.rs`; aqui é o como.
//!
//! **Por que WASAPI direto e não o `cpal`, com prova empírica.** O `cpal` 0.15
//! (dep conhecida da suíte — o LocalScribe grava mic com ele) faz loopback SÓ em
//! modo por evento (`AUDCLNT_STREAMFLAGS_EVENTCALLBACK | ..._LOOPBACK`). Numa
//! máquina desta suíte (driver Realtek), a chamada `IAudioClient::Initialize`
//! desse jeito **TRAVOU** — não devolveu nem sucesso nem erro, ficou pendurada.
//! Um `Initialize` que trava congelaria a gravação. O crate `wasapi` faz igual
//! (mesmos flags) e falhou também. O caminho por **POLLING** (só o flag
//! `..._LOOPBACK`, sem evento; lê com `GetNextPacketSize`/`GetBuffer` num laço
//! de 10ms) é o modelo que o OBS usa e **devolve erro na hora** em vez de
//! travar — então degrada com honestidade. Custa este COM à mão, mas o preço de
//! um travamento na gravação é alto demais. (Naquela mesma máquina, ATÉ um
//! `Initialize` de render comum devolve `0x800706CC` — o endpoint dela não
//! hospeda stream WASAPI nenhum; é ambiente, não este código. Ver o relatório.)
//!
//! Três threads por feed, cada uma com um dono claro:
//!  1. **captura** — dona do `IAudioClient` (COM apartment-bound: nasce, lê e
//!     morre na MESMA thread). Só converte pra i16 e empilha.
//!  2. **escritor** — dono do named pipe. Escreve PACEADO PELO RELÓGIO,
//!     completando com silêncio o que a placa não deu (ver o topo do módulo pai).
//!  3. **medidor** — manda o nível pro sink ~15×/s.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{
    name_matches, plan_chunk, samples_due, sys_pipe_path, to_i16, AudioFormat, AudioLevel,
    LevelSink, SysAudioInfo,
};
use crate::devices::Device;

mod wasapi;
use wasapi::{list_render_names, open_capture, CaptureClient};

/// Folga tolerada antes de descartar áudio velho: 250ms. Acima disso não é
/// "áudio", é atraso — e atraso guardado vira derrapagem permanente.
const BACKLOG_MS: usize = 250;
/// Teto da fila: 5s. Rede de segurança pra RAM se o escritor morrer e a captura
/// continuar empilhando.
const QUEUE_MS: usize = 5_000;
/// Quanto esperar a captura dizer se subiu ou não.
const OPEN_BUDGET: Duration = Duration::from_secs(3);
/// Buffer de saída do pipe (1 MB): ~5s de 48k estéreo. Folga pra um engasgo do
/// ffmpeg não travar o escritor.
const PIPE_BUF: u32 = 1 << 20;

// ---------------------------------------------------------------------------
// Named pipe (o canal de DADOS; o stdin do ffmpeg é o canal de CONTROLE)
// ---------------------------------------------------------------------------

mod pipe {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, WriteFile, FILE_GENERIC_READ, OPEN_EXISTING, PIPE_ACCESS_OUTBOUND,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Ponta servidora do canal. O ffmpeg é o cliente (`-i \\.\pipe\…`).
    pub struct PipeServer {
        h: HANDLE,
    }

    // O HANDLE é um ponteiro cru, então o Rust não sabe que dá pra levá-lo pra
    // outra thread. Dá: um handle de pipe é do PROCESSO, e só o escritor toca
    // neste aqui.
    unsafe impl Send for PipeServer {}

    impl PipeServer {
        /// Cria o canal. RETENTA por ~1s porque o nome é o mesmo a cada
        /// gravação: quando a anterior acabou de parar, o handle dela pode
        /// levar alguns milissegundos pra ser solto pela thread do escritor, e
        /// nesse intervalo o Windows recusa criar outra instância. Falhar aqui
        /// custaria ao usuário a gravação inteira por causa de uma corrida de
        /// 10ms.
        pub fn create(name: &str) -> Result<Self, String> {
            let t0 = std::time::Instant::now();
            loop {
                match Self::try_create(name) {
                    Ok(s) => return Ok(s),
                    Err(e) if t0.elapsed() >= std::time::Duration::from_secs(1) => return Err(e),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                }
            }
        }

        fn try_create(name: &str) -> Result<Self, String> {
            let w = wide(name);
            let h = unsafe {
                CreateNamedPipeW(
                    w.as_ptr(),
                    PIPE_ACCESS_OUTBOUND,
                    PIPE_TYPE_BYTE | PIPE_WAIT,
                    1, // uma instância: uma gravação por vez
                    super::PIPE_BUF,
                    0,
                    0,
                    std::ptr::null(),
                )
            };
            if h == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "não deu pra abrir o canal do áudio do sistema (erro {})",
                    unsafe { GetLastError() }
                ));
            }
            Ok(Self { h })
        }

        /// Espera o ffmpeg abrir o canal. BLOQUEIA — por isso mora na thread do
        /// escritor, e por isso existe o `poke` (o ffmpeg pode nunca vir).
        pub fn wait_connect(&self) -> Result<(), String> {
            let ok = unsafe { ConnectNamedPipe(self.h, std::ptr::null_mut()) };
            if ok == 0 {
                let e = unsafe { GetLastError() };
                // ERROR_PIPE_CONNECTED = o cliente chegou ANTES do connect.
                // É sucesso, não erro (corrida clássica deste API).
                if e != ERROR_PIPE_CONNECTED {
                    return Err(format!("o ffmpeg não abriu o canal de áudio (erro {})", e));
                }
            }
            Ok(())
        }

        pub fn write_all(&self, buf: &[u8]) -> Result<(), String> {
            let mut off = 0usize;
            while off < buf.len() {
                let mut wrote: u32 = 0;
                let ok = unsafe {
                    WriteFile(
                        self.h,
                        buf[off..].as_ptr(),
                        (buf.len() - off) as u32,
                        &mut wrote,
                        std::ptr::null_mut(),
                    )
                };
                if ok == 0 {
                    return Err(format!("canal de áudio caiu (erro {})", unsafe { GetLastError() }));
                }
                if wrote == 0 {
                    return Err("canal de áudio fechado do outro lado".to_string());
                }
                off += wrote as usize;
            }
            Ok(())
        }
    }

    impl Drop for PipeServer {
        fn drop(&mut self) {
            unsafe {
                DisconnectNamedPipe(self.h);
                CloseHandle(self.h);
            }
        }
    }

    /// Acorda um `wait_connect` pendurado: abre o pipe como CLIENTE e fecha na
    /// hora. Sem isto, uma gravação que nem chegou a subir o ffmpeg deixaria a
    /// thread do escritor viva pra sempre — e a próxima gravação não
    /// conseguiria criar o canal (o nome já estaria tomado).
    pub fn poke(name: &str) {
        let w = wide(name);
        let h = unsafe {
            CreateFileW(
                w.as_ptr(),
                FILE_GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if h != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(h) };
        }
    }
}

// ---------------------------------------------------------------------------
// Captura
// ---------------------------------------------------------------------------

/// O que a thread de captura compartilha com o resto.
struct Shared {
    /// `None` = captura só pra medir nível (VU antes de gravar): sem fila, sem
    /// pipe, sem custo de memória.
    queue: Option<Mutex<VecDeque<i16>>>,
    /// Pico do bloco, em bits de f32. Positivo, então `fetch_max` nos bits é
    /// `max` no número (a ordem dos bits acompanha a do valor).
    peak: AtomicU32,
    stop: AtomicBool,
    /// Teto da fila, em amostras. Nasce "sem teto" porque só dá pra calculá-lo
    /// depois que o dispositivo diz a taxa dele — e a captura já está rodando
    /// nessa hora. Teto 0 no meio do caminho jogaria fora o começo do take.
    cap: AtomicUsize,
    /// A placa reclamou no meio do caminho? A UI merece saber.
    err: Mutex<Option<String>>,
}

impl Shared {
    fn new(queue: Option<Mutex<VecDeque<i16>>>) -> Self {
        Self {
            queue,
            peak: AtomicU32::new(0),
            stop: AtomicBool::new(false),
            cap: AtomicUsize::new(usize::MAX),
            err: Mutex::new(None),
        }
    }
    fn fail(&self, msg: String) {
        if let Ok(mut e) = self.err.lock() {
            if e.is_none() {
                *e = Some(msg);
            }
        }
    }
}

/// Qual ponta do som: SAÍDA (loopback — o que o computador está tocando) ou
/// ENTRADA (microfone, só pro medidor).
pub enum Which {
    Output(Option<String>),
    Input(Option<String>),
}

/// Drena um bloco recém-lido do WASAPI pra fila (e atualiza o pico do VU).
///
/// Isolado do laço porque é a única parte "de negócio" da captura — o resto é
/// COM. `silent` = o WASAPI marcou o bloco como silêncio (bandeira
/// AUDCLNT_BUFFERFLAGS_SILENT): o ponteiro pode ser lixo, então NÃO se lê dele,
/// empilha-se zero. É o silêncio HONESTO, na posição certa da linha do tempo.
fn drain_block(shared: &Shared, samples: &[f32], silent: bool) {
    let mut peak = 0f32;
    let mut guard = shared.queue.as_ref().and_then(|q| q.lock().ok());
    for &s in samples {
        let v = if silent { 0.0 } else { s };
        let a = v.abs();
        if a > peak {
            peak = a;
        }
        if let Some(q) = guard.as_mut() {
            q.push_back(to_i16(v));
        }
    }
    if let Some(q) = guard.as_mut() {
        // Teto de RAM: se o escritor morreu, isto aqui não pode comer a máquina
        // do usuário no meio de uma gravação de 2h.
        let cap = shared.cap.load(Ordering::Relaxed);
        if q.len() > cap {
            let excess = q.len() - cap;
            q.drain(..excess);
        }
    }
    drop(guard);
    shared.peak.fetch_max(peak.to_bits(), Ordering::Relaxed);
}

/// Sobe a captura numa thread própria e devolve o formato REAL do dispositivo.
///
/// O `IAudioClient` é COM apartment-bound: nasce, lê e morre nesta thread. O
/// canal existe pra que quem chamou saiba se subiu — sem ele, um "falha ao abrir
/// o dispositivo" viraria silêncio anônimo, que é justo o que este app não pode
/// fazer. E há o `recv_timeout`: se o `Initialize` do driver travar (acontece —
/// ver o topo do módulo), quem chamou recebe erro em vez de congelar.
fn spawn_capture(which: Which, shared: Arc<Shared>) -> Result<(AudioFormat, String), String> {
    let (tx, rx) = channel::<Result<(AudioFormat, String), String>>();
    std::thread::spawn(move || {
        let mut cap: CaptureClient = match open_capture(&which) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        let fmt = cap.format();
        let name = cap.name();
        let _ = tx.send(Ok((fmt, name)));

        // Laço de POLLING: sem evento. 10ms é o passo — folgado pra não girar a
        // CPU, curto pra não deixar o buffer do WASAPI transbordar (o padrão
        // dele é ~10ms de folga). A cada volta drena TODOS os pacotes prontos.
        while !shared.stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(10));
            loop {
                match cap.next_block() {
                    Ok(Some((samples, silent))) => drain_block(&shared, samples, silent),
                    Ok(None) => break, // nada pronto agora
                    Err(e) => {
                        shared.fail(format!("a placa de áudio reclamou: {}", e));
                        return;
                    }
                }
            }
        }
        // O `CaptureClient` faz Stop + libera o COM no seu Drop, aqui na thread.
    });

    match rx.recv_timeout(OPEN_BUDGET) {
        Ok(r) => r,
        Err(_) => Err("o dispositivo de áudio não respondeu a tempo".to_string()),
    }
}

/// Manda o nível pro sink ~15×/s: rápido o bastante pra parecer ao vivo,
/// devagar o bastante pra não afogar a ponte de eventos.
fn level_pump(sink: LevelSink, target: String, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        while !shared.stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(66));
            let peak = f32::from_bits(shared.peak.swap(0, Ordering::Relaxed));
            sink(AudioLevel { target: target.clone(), peak });
        }
        // Zero no fim: sem isto o medidor congelaria no último pico e ficaria
        // dizendo que tem som entrando depois de desligado.
        sink(AudioLevel { target: target.clone(), peak: 0.0 });
    });
}

// ---------------------------------------------------------------------------
// Feed: captura → pipe
// ---------------------------------------------------------------------------

pub struct SysAudioFeed {
    shared: Arc<Shared>,
    connected: Arc<AtomicBool>,
    pipe_name: String,
}

impl SysAudioFeed {
    /// Sobe a captura, cria o canal e deixa o escritor esperando o ffmpeg.
    /// Devolve o formato REAL do dispositivo — é com ele que o front monta o
    /// `-f s16le -ar … -ac … -i \\.\pipe\…`.
    ///
    /// ORDEM IMPORTA em dois pontos:
    ///  - a captura vem primeiro: se a placa recusar, ninguém criou canal nenhum
    ///    pra limpar depois;
    ///  - o canal tem que EXISTIR antes de o ffmpeg abrir — cliente que chega
    ///    antes do servidor toma "arquivo não encontrado" e a gravação morre na
    ///    largada. Por isso este comando roda ANTES do `rec_start`.
    ///
    /// O `sink` do nível é `Option` de PROPÓSITO, e não um `AppHandle`: emitir
    /// evento pra tela é UI, capturar áudio é motor. Com o `AppHandle` aqui, o
    /// `examples/smoke_sysaudio.rs` arrastaria a janela inteira do Tauri pra
    /// dentro de um binário sem manifesto (e não subiria) — ou seja, o motor só
    /// seria exercitável através da UI, que é o mesmo que não ser provável.
    pub fn start(
        sink: Option<LevelSink>,
        device_id: Option<String>,
    ) -> Result<(Self, SysAudioInfo), String> {
        let shared = Arc::new(Shared::new(Some(Mutex::new(VecDeque::new()))));
        let (fmt, name) = match spawn_capture(Which::Output(device_id), shared.clone()) {
            Ok(v) => v,
            Err(e) => {
                shared.stop.store(true, Ordering::Relaxed);
                return Err(e);
            }
        };
        // Agora sim dá pra dizer o teto: 5s do formato que o dispositivo revelou.
        shared.cap.store(
            (fmt.sample_rate as usize) * (fmt.channels as usize) * QUEUE_MS / 1000,
            Ordering::Relaxed,
        );

        let pipe_name = sys_pipe_path();
        let server = match pipe::PipeServer::create(&pipe_name) {
            Ok(s) => s,
            Err(e) => {
                shared.stop.store(true, Ordering::Relaxed);
                return Err(e);
            }
        };

        let connected = Arc::new(AtomicBool::new(false));
        let w_shared = shared.clone();
        let w_conn = connected.clone();
        std::thread::spawn(move || pacer(server, w_shared, fmt, w_conn));
        if let Some(sink) = sink {
            level_pump(sink, "system".to_string(), shared.clone());
        }

        let info = SysAudioInfo {
            id: name.clone(),
            label: name,
            sample_rate: fmt.sample_rate,
            channels: fmt.channels,
            pipe_path: pipe_name.clone(),
        };
        Ok((Self { shared, connected, pipe_name }, info))
    }

    /// Erro que apareceu no caminho (placa reclamou, canal caiu). A gravação
    /// continua — o vídeo importa mais —, mas o usuário precisa saber que aquele
    /// trecho de áudio do sistema é silêncio de verdade.
    pub fn error(&self) -> Option<String> {
        self.shared.err.lock().ok().and_then(|e| e.clone())
    }

    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        if !self.connected.load(Ordering::Relaxed) {
            // O escritor pode estar pendurado no `wait_connect` porque o ffmpeg
            // nem chegou a subir. Um cliente fantasma o acorda pra ele ver o
            // stop e sair (senão: thread e canal vazados).
            pipe::poke(&self.pipe_name);
        }
    }

    /// PROVA sem depender do WASAPI: o MESMO named pipe + o MESMO pacer, mas com
    /// a captura trocada por um gerador de tom (440 Hz, 48k estéreo).
    ///
    /// Existe porque numa máquina cujo endpoint não hospeda stream (o
    /// `Initialize` falha — ver o topo do módulo) a metade da CAPTURA não roda,
    /// mas tudo o que vem DEPOIS dela — o `PipeServer` (CreateNamedPipeW/
    /// ConnectNamedPipe/WriteFile), o pacer paceado pelo relógio, a ingestão do
    /// ffmpeg e o stop gracioso — precisa ser exercitável e provado não-mudo.
    /// O `examples/smoke_sysaudio.rs --synthetic` usa isto.
    pub fn start_synthetic() -> Result<(Self, SysAudioInfo), String> {
        let fmt = AudioFormat { sample_rate: 48_000, channels: 2 };
        let shared = Arc::new(Shared::new(Some(Mutex::new(VecDeque::new()))));
        shared.cap.store(
            (fmt.sample_rate as usize) * (fmt.channels as usize) * QUEUE_MS / 1000,
            Ordering::Relaxed,
        );

        // "Captura" sintética: empilha um tom contínuo no ritmo do tempo real,
        // exatamente como a captura de verdade empilharia o loopback.
        let gen = shared.clone();
        std::thread::spawn(move || {
            let sr = 48_000f32;
            let mut phase = 0f32;
            let mut last = Instant::now();
            while !gen.stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(10));
                let n = (last.elapsed().as_secs_f32() * sr) as usize;
                last = Instant::now();
                if let Some(q) = gen.queue.as_ref() {
                    if let Ok(mut q) = q.lock() {
                        for _ in 0..n {
                            phase += 2.0 * std::f32::consts::PI * 440.0 / sr;
                            let v = (phase.sin()) * 0.4;
                            q.push_back(to_i16(v)); // L
                            q.push_back(to_i16(v)); // R
                        }
                    }
                }
            }
        });

        let pipe_name = sys_pipe_path();
        let server = pipe::PipeServer::create(&pipe_name)?;
        let connected = Arc::new(AtomicBool::new(false));
        let w_shared = shared.clone();
        let w_conn = connected.clone();
        std::thread::spawn(move || pacer(server, w_shared, fmt, w_conn));

        let info = SysAudioInfo {
            id: "TOM SINTÉTICO (prova sem WASAPI)".into(),
            label: "TOM SINTÉTICO (prova sem WASAPI)".into(),
            sample_rate: fmt.sample_rate,
            channels: fmt.channels,
            pipe_path: pipe_name.clone(),
        };
        Ok((Self { shared, connected, pipe_name }, info))
    }
}

/// O escritor: paceado pelo relógio, completando com silêncio (ver o porquê no
/// topo do `sysaudio.rs`).
fn pacer(server: pipe::PipeServer, shared: Arc<Shared>, fmt: AudioFormat, connected: Arc<AtomicBool>) {
    if let Err(e) = server.wait_connect() {
        shared.fail(e);
        return;
    }
    connected.store(true, Ordering::Relaxed);
    if shared.stop.load(Ordering::Relaxed) {
        return;
    }

    let frame = (fmt.sample_rate as usize) * (fmt.channels as usize);
    let max_backlog = frame * BACKLOG_MS / 1000;
    // O relógio começa AGORA, quando o ffmpeg abriu o canal — e não quando a
    // captura subiu. Se contasse antes, o primeiro bloco viria com um buraco de
    // silêncio do tamanho do tempo de spawn do ffmpeg.
    let t0 = Instant::now();
    let mut written: u64 = 0;
    let mut buf: Vec<u8> = Vec::new();

    while !shared.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
        let due = samples_due(t0.elapsed().as_millis() as u64, fmt.sample_rate, fmt.channels);
        buf.clear();
        let plan = {
            let Some(q) = shared.queue.as_ref() else { return };
            let Ok(mut q) = q.lock() else { return };
            let plan = plan_chunk(due, written, q.len(), max_backlog);
            for _ in 0..plan.drop_old {
                q.pop_front();
            }
            for _ in 0..plan.take {
                buf.extend_from_slice(&q.pop_front().unwrap_or(0).to_le_bytes());
            }
            plan
        };
        for _ in 0..plan.pad {
            buf.extend_from_slice(&0i16.to_le_bytes());
        }
        written += (plan.take + plan.pad) as u64;
        if buf.is_empty() {
            continue;
        }
        if let Err(e) = server.write_all(&buf) {
            // Caiu porque o ffmpeg saiu (stop normal) ou porque deu ruim. Se foi
            // stop, ninguém liga; se não foi, o `error()` conta.
            if !shared.stop.load(Ordering::Relaxed) {
                shared.fail(e);
            }
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Medidor avulso (antes de gravar)
// ---------------------------------------------------------------------------

/// Um medidor POR FONTE (mic e sistema são duas barras na tela ao mesmo tempo),
/// daí o mapa em vez de um slot só.
#[derive(Default)]
pub struct MonitorState {
    inner: Mutex<std::collections::HashMap<String, Arc<Shared>>>,
}

pub fn monitor_start(
    sink: LevelSink,
    state: &MonitorState,
    target: &str,
    device_id: Option<String>,
) -> Result<(), String> {
    // Um medidor por FONTE: trocar de dispositivo no <select> não pode deixar o
    // anterior vivo empurrando o nível de outro aparelho pra mesma barra.
    monitor_stop(state, Some(target));
    let which = match target {
        "mic" => Which::Input(device_id),
        "system" => Which::Output(device_id),
        other => return Err(format!("fonte de áudio desconhecida: {}", other)),
    };
    let shared = Arc::new(Shared::new(None));
    if let Err(e) = spawn_capture(which, shared.clone()) {
        shared.stop.store(true, Ordering::Relaxed);
        return Err(e);
    }
    level_pump(sink, target.to_string(), shared.clone());
    if let Ok(mut g) = state.inner.lock() {
        g.insert(target.to_string(), shared);
    }
    Ok(())
}

/// `None` = desliga todos (é o que a gravação faz: o medidor não pode disputar
/// o microfone com o ffmpeg).
pub fn monitor_stop(state: &MonitorState, target: Option<&str>) {
    if let Ok(mut g) = state.inner.lock() {
        match target {
            Some(t) => {
                if let Some(s) = g.remove(t) {
                    s.stop.store(true, Ordering::Relaxed);
                }
            }
            None => {
                for (_, s) in g.drain() {
                    s.stop.store(true, Ordering::Relaxed);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Enumeração
// ---------------------------------------------------------------------------

/// Saídas de áudio. A PADRÃO vem primeiro: é ela que o usuário quer em 99% dos
/// casos, e a UI só faz `[0]` pra acertar sem heurística própria.
pub fn list_outputs() -> Vec<Device> {
    // `list_render_names` já devolve a PADRÃO em primeiro (contrato do módulo
    // wasapi) — a UI só faz `[0]` e acerta sem heurística própria.
    list_render_names()
        .unwrap_or_default()
        .into_iter()
        .map(|n| Device { id: n.clone(), label: n })
        .collect()
}

/// Sonda a saída sem gravar: só confirma que ela existe e diz o nome/formato.
///
/// NÃO faz um `Initialize` de teste de propósito: em máquina cujo endpoint não
/// hospeda stream (ver o topo do módulo), o `Initialize` é justamente o que
/// falha — e a sonda serve pra decidir se o botão fica ligável, não pra provar
/// captura. A prova vem no `sys_audio_start`, que degrada com honestidade se o
/// `Initialize` real falhar.
pub fn probe(device_id: Option<String>) -> Result<SysAudioInfo, String> {
    let (name, fmt) = wasapi::describe_render(device_id.as_deref())?;
    Ok(SysAudioInfo {
        id: name.clone(),
        label: name,
        sample_rate: fmt.sample_rate,
        channels: fmt.channels,
        pipe_path: sys_pipe_path(),
    })
}
