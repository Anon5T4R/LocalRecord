//! Motor de gravação (onda 2): long-running com handle.
//!
//! A diferença que manda neste arquivo: o `ff_run` do LocalMedia é
//! converte-arquivo-e-espera — bloqueia até o processo sair. Gravação NÃO é
//! isso. Aqui `rec_start` faz spawn, guarda o `Child` e **volta na hora**; quem
//! lê o progresso é uma thread própria. Copiar o `ff_run` cego travaria a UI
//! pelo tempo inteiro da gravação.
//!
//! Os três pontos que este módulo existe pra acertar:
//!
//! 1. **Stop gracioso.** `kill()` num ffmpeg gravando deixa o arquivo sem
//!    índice/trailer. O certo é mandar `q` no stdin e ESPERAR ele fechar o
//!    contêiner — por isso o spawn usa `stdin(Stdio::piped())` e NÃO passa
//!    `-nostdin` (o LocalMedia faz os dois ao contrário, porque nunca precisa
//!    conversar com o processo). `kill()` só como último recurso, depois de ~5s.
//! 2. **Dois pipes, duas threads.** Ler só um deles trava o ffmpeg quando o
//!    outro enche o buffer do SO (gotcha #3).
//! 3. **MKV durante, MP4 no fim.** MKV aguenta queda de luz; o MP4 sai de um
//!    remux `-c copy` no fim. Se o remux falhar, o MKV FICA — nunca se perde
//!    um take por causa do último passo.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::ffmpeg::{no_window, parse_progress_line, resolve_bin, FFMPEG_BIN};
use crate::sysaudio::SysAudioState;

/// Quanto esperar o ffmpeg fechar o contêiner sozinho antes de partir pro kill.
const STOP_BUDGET_MS: u64 = 5_000;
/// Janela pra decidir que a captura "nem começou" (fonte inválida, DDA negada).
const START_PROBE_MS: u64 = 1_500;
/// Linhas de stderr guardadas pro rabo de erro.
const ERR_TAIL: usize = 30;

/// Marcadores de "a captura de tela MORREU no meio da gravação".
///
/// Existe porque o ffmpeg NÃO aborta quando uma entrada morre: ele reclama uma
/// vez no stderr e segue gravando as OUTRAS. O resultado é o pior tipo de
/// arquivo — um take de 2 minutos com áudio perfeito e UM quadro de vídeo, e o
/// app anunciando "salvo". Foi exatamente o que os testes reais do João
/// produziram em 2026-07-18 (`docs/planos/localrecord-achados-teste-real.md`).
///
/// `887a0026` é o `DXGI_ERROR_ACCESS_LOST` da Desktop Duplication API — o
/// `ddagrab` perde o acesso e não volta sozinho.
const CAPTURE_LOST_MARKERS: [&str; 3] = ["AcquireNextFrame failed", "887a0026", "Error during demuxing"];

/// A captura de tela morreu no meio? Procura os marcadores no rabo do stderr.
fn capture_lost(tail: &str) -> bool {
    CAPTURE_LOST_MARKERS.iter().any(|m| tail.contains(m))
}

/// Onde fica o log do ffmpeg de um take: o mesmo caminho do MKV com `.log`.
///
/// Ao lado da gravação de propósito — quem for investigar um take estranho acha
/// o log sem saber onde o app guarda nada.
fn log_path_for(mkv: &Path) -> PathBuf {
    mkv.with_extension("log")
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordOpts {
    /// Linha de comando montada no front (`src/lib/args.ts`).
    pub args: Vec<String>,
    /// Plano B se a captura não subir (ddagrab → gdigrab). Front que monta.
    pub fallback_args: Option<Vec<String>>,
    /// Args do remux MKV→MP4, guardados agora pra usar no stop.
    pub remux_args: Vec<String>,
    pub mkv_path: String,
    pub mp4_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub mkv_path: String,
    /// true = a fonte principal falhou e caímos no gdigrab (a UI avisa).
    pub used_fallback: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordDone {
    /// Onde o take REALMENTE está (mp4 se o remux deu certo, senão o mkv).
    pub path: String,
    /// false = o ffmpeg não saiu no prazo e levou kill (o MKV salva o take).
    pub graceful: bool,
    /// false = o remux falhou e o arquivo final é o MKV.
    pub remuxed: bool,
    /// O áudio do sistema deu problema no meio do caminho? Vem o motivo. A
    /// gravação não é desfeita por causa disso (o vídeo vale mais), mas o
    /// usuário PRECISA saber que aquele trecho é silêncio de verdade — descobrir
    /// no play seria a pior hora possível.
    pub sys_audio_error: Option<String>,
    /// A captura de TELA morreu no meio da gravação (o áudio segue bom, o vídeo
    /// congela). O usuário precisa saber AGORA — descobrir no play, depois de
    /// gravar 2 minutos, é a pior hora possível.
    pub capture_lost: bool,
    /// Onde ficou o log do ffmpeg, quando ele foi preservado. `None` = o take
    /// saiu limpo e o log foi apagado (não sujar a pasta de gravações).
    pub log_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecProgress {
    /// MILISSEGUNDOS. O `out_time_ms` do ffmpeg vem em MICROssegundos
    /// (gotcha #1) — a divisão por 1000 acontece aqui, uma vez só.
    elapsed_ms: u64,
    fps: String,
    size_bytes: u64,
    speed: String,
}

/// Uma gravação viva.
struct Rec {
    child: Child,
    mkv: PathBuf,
    mp4: PathBuf,
    remux_args: Vec<String>,
    err: Arc<Mutex<VecDeque<String>>>,
    /// Log do ffmpeg deste take. Escrito em STREAMING durante a gravação (não
    /// só no fim): se o app morrer no meio, o log do que aconteceu sobrevive.
    log: PathBuf,
}

/// Uma gravação por vez (v0.1). O `Option` é o estado inteiro: `None` = parado.
#[derive(Default)]
pub struct RecState {
    inner: Mutex<Option<Rec>>,
}

/// O que fazer a cada volta da espera do stop. Isolado do mundo pra ser testável
/// sem processo nenhum — é a regra que decide "gracioso vs. kill".
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum StopStep {
    /// Saiu sozinho: contêiner fechado direito.
    Done,
    /// Ainda escrevendo o trailer — dar mais tempo.
    Wait,
    /// Estourou o orçamento: matar (o MKV aguenta).
    Kill,
}

pub fn stop_step(exited: bool, elapsed_ms: u64, budget_ms: u64) -> StopStep {
    if exited {
        StopStep::Done
    } else if elapsed_ms >= budget_ms {
        StopStep::Kill
    } else {
        StopStep::Wait
    }
}

/// Guarda a linha no rabo de erro, jogando fora a mais velha (anel limitado):
/// um ffmpeg reclamando em loop não pode comer a RAM da máquina.
fn push_tail(tail: &mut VecDeque<String>, line: String, cap: usize) {
    tail.push_back(line);
    while tail.len() > cap {
        tail.pop_front();
    }
}

/// Caminho livre: acrescenta " (n)" antes da extensão até não colidir.
/// Duas gravações no mesmo minuto não podem sobrescrever uma à outra.
fn unique_path_impl(path: &str, exists: impl Fn(&str) -> bool) -> String {
    if !exists(path) {
        return path.to_string();
    }
    let p = Path::new(path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("gravacao");
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for n in 1..1000 {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, n)
        } else {
            format!("{} ({}).{}", stem, n, ext)
        };
        let candidate = dir.join(name);
        let s = candidate.to_string_lossy().to_string();
        if !exists(&s) {
            return s;
        }
    }
    path.to_string()
}

#[tauri::command(async)]
pub fn unique_path(path: String) -> String {
    unique_path_impl(&path, |p| Path::new(p).exists())
}

/// Pasta padrão das gravações: Vídeos/LocalRecord (criada se não existir).
#[tauri::command(async)]
pub fn rec_default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("pasta de vídeos indisponível: {}", e))?
        .join("LocalRecord");
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar {}: {}", dir.display(), e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Escolhe o encoder testando de VERDADE: codifica 0,1s de nada e vê se passa.
///
/// Por que não confiar no `-encoders`: aquela lista diz o que foi COMPILADO no
/// build, não o que a máquina tem. O build BtbN lista nvenc, qsv e amf sempre —
/// numa máquina AMD, escolher nvenc pela lista daria erro só na hora de gravar,
/// que é o pior momento possível. 0,1s de teste agora evita isso.
#[tauri::command(async)]
pub fn rec_pick_encoder(app: tauri::AppHandle) -> String {
    let Ok(ffmpeg) = resolve_bin(&app, FFMPEG_BIN) else {
        return "libx264".to_string();
    };
    // Hardware primeiro (custa menos CPU, que é o recurso disputado enquanto se
    // grava a tela); x264 é a rede de segurança que sempre existe.
    for enc in ["h264_nvenc", "h264_qsv", "h264_amf"] {
        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "nullsrc=s=256x144:d=0.1,format=yuv420p",
            "-c:v",
            enc,
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        no_window(&mut cmd);
        if let Ok(status) = cmd.status() {
            if status.success() {
                return enc.to_string();
            }
        }
    }
    "libx264".to_string()
}

/// Um quadro da tela em JPG (bytes) pro preview montar o palco.
///
/// Vai pra memória e volta como bytes em vez de virar arquivo servido pelo
/// asset protocol: é UMA imagem, morre na hora, e assim não precisa abrir
/// permissão de asset nem limpar lixo em disco depois.
#[tauri::command(async)]
pub fn rec_screen_thumb(app: tauri::AppHandle, args: Vec<String>) -> Result<Vec<u8>, String> {
    let ffmpeg = resolve_bin(&app, FFMPEG_BIN)?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error"])
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("falha ao rodar ffmpeg: {}", e))?;
    if !out.status.success() || out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("não consegui capturar a tela: {}", err.trim()));
    }
    Ok(out.stdout)
}

/// Sobe o ffmpeg com os pipes do jeito que gravação precisa.
///
/// `pub` porque o `examples/smoke_record.rs` grava de verdade por aqui: o smoke
/// tem que exercitar ESTA função, não uma cópia dela — cópia não prova nada.
pub fn spawn_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<Child, String> {
    let mut cmd = Command::new(ffmpeg);
    // Sem `-nostdin` DE PROPÓSITO: o stdin é o canal do `q` do stop gracioso.
    cmd.args(["-hide_banner", "-y", "-progress", "pipe:1", "-loglevel", "error"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("falha ao iniciar ffmpeg: {}", e))
}

/// Tenta uma linha de args e devolve o processo VIVO, com as threads de leitura
/// já rodando. Erro = a captura não subiu (fonte inválida, DDA negada…).
fn try_start(
    app: &tauri::AppHandle,
    ffmpeg: &Path,
    args: &[String],
    log: &Path,
) -> Result<(Child, Arc<Mutex<VecDeque<String>>>), String> {
    let mut child = spawn_ffmpeg(ffmpeg, args)?;
    let stdout = child.stdout.take().ok_or("sem stdout do ffmpeg")?;
    let stderr = child.stderr.take().ok_or("sem stderr do ffmpeg")?;

    // O log abre em APPEND: quando o ddagrab não sobe e caímos no gdigrab, o
    // `try_start` roda duas vezes e as duas tentativas têm que ficar no mesmo
    // arquivo — o motivo da primeira ter falhado é justamente o que se quer ler.
    // Falhar ao abrir o log NÃO impede gravar: log é diagnóstico, não requisito.
    let mut sink = std::fs::OpenOptions::new().create(true).append(true).open(log).ok();
    if let Some(f) = sink.as_mut() {
        let _ = writeln!(f, "\n===== ffmpeg {} =====", args.join(" "));
    }

    // Thread do stderr: rabo de erro em memória (pra mensagem imediata) E o log
    // COMPLETO em disco. Precisa começar JÁ — se ninguém ler este pipe e ele
    // encher, o ffmpeg trava (gotcha #3).
    //
    // Em disco vai tudo, não só as últimas 30 linhas: o erro que interessa
    // costuma acontecer no COMEÇO (o `AcquireNextFrame failed` do ddagrab sai
    // uma vez só) e some do rabo depois de dois minutos de aviso de encoder.
    let err: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let err_c = err.clone();
    std::thread::spawn(move || {
        // Re-liga `mut` dentro da thread: a mutabilidade do binding de fora não
        // atravessa a captura por `move` de forma óbvia, e depender disso é
        // pedir erro de compilação que só o CI ia mostrar.
        let mut sink = sink;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(f) = sink.as_mut() {
                let _ = writeln!(f, "{}", line);
            }
            if let Ok(mut v) = err_c.lock() {
                push_tail(&mut v, line, ERR_TAIL);
            }
        }
    });

    // A captura só é "de verdade" se o processo continuar de pé. Fonte errada
    // faz o ffmpeg morrer em ~200ms — esperar aqui é o que permite cair no
    // gdigrab HONESTAMENTE, em vez de jurar que gravou e entregar 0 byte.
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(START_PROBE_MS) {
        match child.try_wait() {
            Ok(Some(_)) => {
                let tail = err.lock().map(|v| v.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
                let msg = tail.trim().to_string();
                return Err(if msg.is_empty() { "a captura não iniciou".into() } else { msg });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("esperar ffmpeg: {}", e)),
        }
    }

    // De pé: agora sim a thread de progresso.
    let app_c = app.clone();
    std::thread::spawn(move || {
        let mut p = RecProgress {
            elapsed_ms: 0,
            fps: String::new(),
            size_bytes: 0,
            speed: String::new(),
        };
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match parse_progress_line(&line) {
                // µs → ms, o gotcha #1 pago aqui.
                Some(("t", v)) => p.elapsed_ms = v.parse::<i64>().unwrap_or(0).max(0) as u64 / 1000,
                Some(("fps", v)) => p.fps = v,
                Some(("size", v)) => p.size_bytes = v.parse::<u64>().unwrap_or(0),
                Some(("speed", v)) => p.speed = v,
                // O ffmpeg fecha cada bloco com `progress=`; só aí o retrato
                // está completo e vale emitir.
                Some(("progress", _)) => {
                    let _ = app_c.emit("rec-progress", p.clone());
                }
                _ => {}
            }
        }
    });

    Ok((child, err))
}

/// Começa a gravar. VOLTA NA HORA — não espera o ffmpeg terminar.
#[tauri::command(async)]
pub fn rec_start(
    app: tauri::AppHandle,
    state: State<'_, RecState>,
    sys: State<'_, SysAudioState>,
    opts: RecordOpts,
) -> Result<RecordingInfo, String> {
    {
        let guard = state.inner.lock().map_err(|_| "estado corrompido")?;
        if guard.is_some() {
            return Err("já existe uma gravação em andamento".into());
        }
    }
    let ffmpeg = resolve_bin(&app, FFMPEG_BIN)?;

    // O log nasce ANTES da 1ª tentativa: se nem o ddagrab nem o gdigrab subirem,
    // o motivo dos dois fica gravado (é o único caso em que não há take pra
    // olhar depois). Um take anterior com o mesmo nome não deve poluir este.
    let mkv = PathBuf::from(&opts.mkv_path);
    let log = log_path_for(&mkv);
    let _ = std::fs::remove_file(&log);

    let (child, err, used_fallback) = match try_start(&app, &ffmpeg, &opts.args, &log) {
        Ok((c, e)) => (c, e, false),
        Err(first) => {
            // Plano B honesto: só cai no gdigrab se o ddagrab REALMENTE não
            // subiu, e avisa a UI (o usuário merece saber que está no caminho
            // lento — gdigrab custa CPU e não pega janelas com overlay).
            let Some(fb) = opts.fallback_args.clone() else {
                crate::sysaudio::stop_feed(&sys);
                return Err(first);
            };
            let _ = app.emit("rec-notice", first.clone());
            // O canal do áudio do sistema morreu junto com a 1ª tentativa (o
            // named pipe vive enquanto o ffmpeg que o abriu vive). Sem refazer,
            // o plano B nasceria sem o que abrir e falharia por um motivo que
            // nada tem a ver com o gdigrab.
            if let Err(e) = crate::sysaudio::restart_feed(&app, &sys) {
                crate::sysaudio::stop_feed(&sys);
                return Err(format!("{} | e o canal do áudio do sistema não voltou: {}", first, e));
            }
            match try_start(&app, &ffmpeg, &fb, &log) {
                Ok((c, e)) => (c, e, true),
                Err(second) => {
                    crate::sysaudio::stop_feed(&sys);
                    return Err(format!("{} | fallback também falhou: {}", first, second));
                }
            }
        }
    };

    let rec = Rec {
        child,
        mkv: mkv.clone(),
        mp4: PathBuf::from(&opts.mp4_path),
        remux_args: opts.remux_args,
        err,
        log,
    };
    *state.inner.lock().map_err(|_| "estado corrompido")? = Some(rec);

    Ok(RecordingInfo { mkv_path: mkv.to_string_lossy().to_string(), used_fallback })
}

/// Manda o `q` e espera o ffmpeg fechar o contêiner. `false` = precisou de kill.
///
/// Não é `kill()` porque kill deixa o arquivo sem índice/trailer. O `q` é o
/// pedido educado: "pare de capturar e feche direito".
///
/// Recebe `&mut Child` (e não o `Rec`) pra ser exercitável pelo smoke com
/// ffmpeg real — é a função que PRECISA de prova empírica.
pub fn graceful_stop(child: &mut Child) -> bool {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    // Soltar o stdin fecha o pipe: mesmo que o `q` se perca, o ffmpeg vê EOF.
    drop(child.stdin.take());

    let t0 = Instant::now();
    loop {
        let exited = matches!(child.try_wait(), Ok(Some(_)));
        match stop_step(exited, t0.elapsed().as_millis() as u64, STOP_BUDGET_MS) {
            StopStep::Done => return true,
            StopStep::Wait => std::thread::sleep(Duration::from_millis(100)),
            StopStep::Kill => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Para a gravação e entrega o MP4.
#[tauri::command(async)]
pub fn rec_stop(
    app: tauri::AppHandle,
    state: State<'_, RecState>,
    sys: State<'_, SysAudioState>,
) -> Result<RecordDone, String> {
    // Sai do estado JÁ: um segundo clique no stop não pode pegar o mesmo Child.
    let mut rec = state
        .inner
        .lock()
        .map_err(|_| "estado corrompido")?
        .take()
        .ok_or("não há gravação em andamento")?;

    // ORDEM que importa pro áudio:
    //  1. sinaliza o feed a parar ANTES do `q`. Assim, quando o ffmpeg fechar o
    //     cano no shutdown, a quebra é ESPERADA e o pacer não a confunde com um
    //     erro real (senão TODO stop acenderia um falso "o áudio caiu no meio").
    //  2. o `q` e a espera do trailer.
    //  3. só então lê o erro (que agora só tem falha REAL de meio de gravação) e
    //     desmonta o feed de vez.
    crate::sysaudio::signal_feed_stop(&sys);
    let graceful = graceful_stop(&mut rec.child);
    let sys_audio_error = crate::sysaudio::feed_error(&sys);
    crate::sysaudio::stop_feed(&sys);

    if !rec.mkv.exists() {
        let tail = rec.err.lock().map(|v| v.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let msg = tail.trim();
        return Err(if msg.is_empty() {
            "a gravação não gerou arquivo".into()
        } else {
            format!("a gravação não gerou arquivo: {}", msg)
        });
    }

    // Remux MKV→MP4. Aqui SIM é converte-e-espera (é `-c copy`, dura o tempo de
    // copiar os bytes) — o padrão do LocalMedia serve certinho neste passo.
    let ffmpeg = resolve_bin(&app, FFMPEG_BIN)?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-y", "-loglevel", "error"])
        .args(&rec.remux_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("falha ao rodar ffmpeg: {}", e))?;

    let remuxed = out.status.success() && rec.mp4.exists();

    // A captura de tela morreu no meio? O ffmpeg reclama UMA vez no stderr e
    // segue gravando as outras entradas, então sem esta checagem o take sai com
    // áudio perfeito, vídeo congelado e a UI dizendo "salvo".
    let tail = rec.err.lock().map(|v| v.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
    let lost = capture_lost(&tail);

    // O log fica quando ALGO deu errado; some quando o take saiu limpo. Guardar
    // sempre encheria a pasta de gravações de `.log` que ninguém vai ler — e
    // arquivo que sempre existe é arquivo que ninguém percebe.
    let keep_log = lost || !graceful || !remuxed || sys_audio_error.is_some();
    let log_path = if keep_log {
        Some(rec.log.to_string_lossy().to_string())
    } else {
        let _ = std::fs::remove_file(&rec.log);
        None
    };

    let done = if remuxed {
        // Só agora o MKV pode sair: o MP4 existe e está fechado. Apagar antes
        // seria trocar um arquivo bom por um talvez.
        let _ = std::fs::remove_file(&rec.mkv);
        RecordDone {
            path: rec.mp4.to_string_lossy().to_string(),
            graceful,
            remuxed: true,
            sys_audio_error,
            capture_lost: lost,
            log_path,
        }
    } else {
        // Remux falhou: o take NÃO se perde. Fica o MKV, que é reproduzível, e
        // a UI diz onde ele está.
        RecordDone {
            path: rec.mkv.to_string_lossy().to_string(),
            graceful,
            remuxed: false,
            sys_audio_error,
            capture_lost: lost,
            log_path,
        }
    };
    let _ = app.emit("rec-done", done.clone());
    Ok(done)
}

/// A UI está gravando? (reconciliação depois de recarregar a webview)
#[tauri::command(async)]
pub fn rec_status(state: State<'_, RecState>) -> bool {
    state.inner.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Chamado no `RunEvent::Exit`: fechar o app não pode corromper um take.
///
/// Faz só o `q` + espera (o contêiner fecha e o MKV fica íntegro). NÃO remuxa:
/// remux de uma gravação longa seguraria o app fechando por vários segundos, e
/// o MKV já é um arquivo válido — o usuário abre normalmente.
pub fn stop_on_exit(state: &RecState, sys: &SysAudioState) {
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(rec) = guard.as_mut() {
            graceful_stop(&mut rec.child);
        }
        *guard = None;
    }
    // Depois do `q`, pela mesma razão do rec_stop. E incondicional: se o app
    // fecha sem gravação nenhuma, pode haver feed vivo de um start que deu
    // errado no meio — o canal e as threads dele não podem sobreviver ao app.
    crate::sysaudio::stop_feed(sys);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_espera_antes_de_matar() {
        // O coração do stop gracioso: enquanto houver orçamento, ESPERA.
        assert_eq!(stop_step(false, 0, 5000), StopStep::Wait);
        assert_eq!(stop_step(false, 4999, 5000), StopStep::Wait);
        // Saiu sozinho = fechou o contêiner direito, em qualquer instante.
        assert_eq!(stop_step(true, 0, 5000), StopStep::Done);
        assert_eq!(stop_step(true, 9999, 5000), StopStep::Done);
        // Estourou o prazo: aí sim mata (o MKV aguenta).
        assert_eq!(stop_step(false, 5000, 5000), StopStep::Kill);
        assert_eq!(stop_step(false, 6000, 5000), StopStep::Kill);
    }

    #[test]
    fn stop_nunca_mata_quem_ja_saiu() {
        // Regressão: `exited` manda mais que o relógio. Se o ffmpeg saiu no
        // limite do prazo, o caminho é Done — matar aqui seria kill à toa.
        assert_eq!(stop_step(true, 5000, 5000), StopStep::Done);
    }

    #[test]
    fn rabo_de_erro_e_limitado() {
        let mut tail = VecDeque::new();
        for i in 0..100 {
            push_tail(&mut tail, format!("linha {}", i), 30);
        }
        // Fica só o FIM: é onde o ffmpeg diz por que desistiu.
        assert_eq!(tail.len(), 30);
        assert_eq!(tail.front().unwrap(), "linha 70");
        assert_eq!(tail.back().unwrap(), "linha 99");
    }

    #[test]
    fn caminho_unico_nao_sobrescreve_take() {
        let taken = ["C:/v/a.mkv", "C:/v/a (1).mkv"];
        let got = unique_path_impl("C:/v/a.mkv", |p| taken.contains(&p.replace('\\', "/").as_str()));
        assert_eq!(got.replace('\\', "/"), "C:/v/a (2).mkv");
        assert_eq!(unique_path_impl("C:/v/b.mkv", |_| false), "C:/v/b.mkv");
    }

    #[test]
    fn caminho_unico_aguenta_nome_sem_extensao() {
        let got = unique_path_impl("C:/v/take", |p| p.replace('\\', "/") == "C:/v/take");
        assert_eq!(got.replace('\\', "/"), "C:/v/take (1)");
    }

    #[test]
    fn detecta_captura_perdida_no_stderr() {
        // As linhas REAIS que o ffmpeg cospe quando o ddagrab perde o acesso —
        // colhidas reproduzindo o bug dos testes do João em 2026-07-18.
        let real = "[Parsed_ddagrab_0 @ 000001f8] AcquireNextFrame failed: 887a0026\n\
                    [in#0/lavfi @ 000001f8] Error during demuxing: Generic error in an external library";
        assert!(capture_lost(real));
        // Cada marcador sozinho também tem que pegar: o ffmpeg nem sempre cospe
        // os dois, e um take de 2 minutos empurra o começo pra fora do rabo.
        assert!(capture_lost("AcquireNextFrame failed: 887a0026"));
        assert!(capture_lost("Error during demuxing: whatever"));
    }

    #[test]
    fn stderr_normal_nao_e_captura_perdida() {
        // Falso positivo aqui é pior que falso negativo: acusaria take bom de
        // quebrado e o aviso viraria ruído que o usuário aprende a ignorar.
        let normal = "[libx264 @ 0000] using cpu capabilities: MMX2 SSE2Fast\n\
                      frame= 1234 fps= 30 q=23.0 size= 4096kB\n\
                      [aac @ 0000] Qavg: 610.136";
        assert!(!capture_lost(normal));
        assert!(!capture_lost(""));
    }

    #[test]
    fn log_fica_ao_lado_do_take() {
        let got = log_path_for(Path::new("C:/v/gravacao-2026-07-18.mkv"));
        assert_eq!(got.to_string_lossy().replace('\\', "/"), "C:/v/gravacao-2026-07-18.log");
        // Nome com ponto no meio não pode virar log de outro take.
        let got2 = log_path_for(Path::new("C:/v/take 1.2.mkv"));
        assert_eq!(got2.to_string_lossy().replace('\\', "/"), "C:/v/take 1.2.log");
    }
}
