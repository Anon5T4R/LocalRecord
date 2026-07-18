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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::ffmpeg::{no_window, parse_progress_line, resolve_bin, FFMPEG_BIN, FFPROBE_BIN};
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
/// `ddagrab` perde o acesso e não volta sozinho. Estes dois só saem da captura
/// de tela (nome do filtro e código da DXGI), então podem ser procurados em
/// qualquer lugar do stderr.
const CAPTURE_LOST_MARKERS: [&str; 2] = ["AcquireNextFrame failed", "887a0026"];

/// `Error during demuxing` é de QUALQUER entrada — o ffmpeg usa a mesma frase
/// pro cano do áudio do sistema (`[in#3/s16le] Error during demuxing: Invalid
/// argument`, que aconteceu nos TRÊS takes de 2026-07-18 07:0x). Procurar essa
/// frase solta acusava "a captura de tela parou" numa gravação em que ela não
/// tinha parado.
///
/// A tela é SEMPRE a entrada 0 (ver `buildRecordArgs` — a ordem do layout de
/// índices é contrato do front), então o prefixo `in#0/` é o que separa uma
/// coisa da outra.
const DEMUX_ERROR: &str = "Error during demuxing";
const SCREEN_INPUT: &str = "in#0/";

/// A captura de TELA morreu no meio? Decide linha a linha, não no texto inteiro:
/// procurar as duas coisas no bolo faria a frase genérica de uma linha casar com
/// o `in#0/` de outra.
fn capture_lost(tail: &str) -> bool {
    tail.lines().any(|l| {
        CAPTURE_LOST_MARKERS.iter().any(|m| l.contains(m))
            || (l.contains(DEMUX_ERROR) && l.contains(SCREEN_INPUT))
    })
}

/// A linha é o ffmpeg recusando o PCM do cano? O PCM cru é a única entrada
/// `s16le` do grafo, então a entrada identifica a fonte.
///
/// **Só reconhece a linha — não decide nada.** Quem decide é a thread do
/// stderr, que sabe se o stop já foi pedido: no encerramento normal o cano é
/// fechado de propósito e o ffmpeg SEMPRE reclama. Medi num take real
/// (2026-07-18 07:08): a faixa do sistema tinha 40,4 s contra 41,0 s do mic e
/// silêncio digital limpo — o erro era o fim do cano, não perda no meio.
/// Tratar essa linha como falha acenderia alarme em toda gravação.
fn sys_audio_line(line: &str) -> bool {
    line.contains(DEMUX_ERROR) && line.contains("s16le")
}

/// Abaixo de qual fração do fps alvo a gravação conta como degradada.
///
/// Metade: acima disso é engasgo normal de máquina ocupada (e o usuário não
/// pode ser interrompido a cada pico), abaixo disso o take não serve.
const FPS_ALERT_RATIO: f64 = 0.5;
/// Quantas amostras seguidas abaixo do limiar antes de falar. O ffmpeg emite
/// um bloco de progresso por segundo, então são ~3s.
///
/// Não é 1 de propósito: o PRIMEIRO bloco sempre vem com fps baixo (o encoder
/// ainda está subindo) e avisar ali seria mentir em toda gravação boa.
const FPS_ALERT_SAMPLES: usize = 3;

/// Já dá pra dizer que a gravação está degradada? Recebe as amostras de fps na
/// ordem em que chegaram e o alvo.
///
/// Pura de propósito: é a regra que decide interromper o usuário no meio de uma
/// gravação, e regra dessas tem que ser testável sem ffmpeg nenhum.
fn fps_degraded(samples: &[f64], target: f64) -> bool {
    if target <= 0.0 || samples.len() < FPS_ALERT_SAMPLES {
        return false;
    }
    let limite = target * FPS_ALERT_RATIO;
    // Só as últimas: um vale no começo não condena o resto da gravação.
    samples[samples.len() - FPS_ALERT_SAMPLES..].iter().all(|f| *f < limite)
}

/// Abaixo de qual fração dos quadros esperados o take conta como degenerado.
///
/// Mais frouxo que o alerta ao vivo (que usa metade): aqui é o veredito final e
/// falso positivo custa caro — dizer "seu take quebrou" pra quem gravou dez
/// minutos bons é pior que deixar passar uma degradação leve, que o alerta ao
/// vivo já pegou.
const TAKE_MIN_RATIO: f64 = 0.25;

/// O take saiu degenerado? Compara os quadros que o arquivo REALMENTE tem com os
/// que a duração e o fps alvo prometiam.
///
/// Existe porque o `rec_stop` só sabia checar se o remux deu certo — e o remux
/// de um vídeo com 1 quadro dá certo. Um `-c copy` copia com perfeição um
/// arquivo quebrado.
fn take_degraded(frames: u64, duration_s: f64, target: f64) -> bool {
    // Sem alvo ou take curto demais: não dá pra afirmar nada, e afirmar sem
    // base é o que transforma aviso em ruído. 2s porque abaixo disso o próprio
    // arredondamento do fps já explica a diferença.
    if target <= 0.0 || duration_s < 2.0 {
        return false;
    }
    let esperados = duration_s * target;
    (frames as f64) < esperados * TAKE_MIN_RATIO
}

/// Quantos pacotes de vídeo e quantos segundos o arquivo tem de verdade.
///
/// `-count_packets` (e não `-count_frames`): conta desmuxando, sem decodificar.
/// Num take de 10 minutos a diferença é entre instantâneo e dezenas de segundos
/// — e pacote de vídeo é a mesma unidade que interessa aqui.
fn probe_video(ffprobe: &Path, file: &Path) -> Option<(u64, f64)> {
    let mut cmd = Command::new(ffprobe);
    cmd.args([
        "-v", "error",
        "-select_streams", "v:0",
        "-count_packets",
        "-show_entries", "stream=nb_read_packets,duration",
        "-of", "default=nokey=1:noprint_wrappers=1",
    ])
    .arg(file)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    parse_probe_video(&txt)
}

/// Lê a saída do `probe_video`. Separada pra ser testável sem ffprobe.
///
/// A ordem dos campos segue a do `-show_entries` (`duration` antes de
/// `nb_read_packets` na struct do ffprobe), e `duration` pode vir `N/A` em MKV —
/// por isso a leitura é por conteúdo, não por posição: o inteiro grande é a
/// contagem, o decimal é a duração.
fn parse_probe_video(txt: &str) -> Option<(u64, f64)> {
    let mut frames: Option<u64> = None;
    let mut dur: Option<f64> = None;
    for l in txt.lines().map(str::trim).filter(|l| !l.is_empty() && *l != "N/A") {
        if l.contains('.') {
            dur = l.parse::<f64>().ok().or(dur);
        } else if let Ok(n) = l.parse::<u64>() {
            frames = Some(n);
        }
    }
    Some((frames?, dur?))
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
    /// Fps que a gravação PEDIU. Serve pra comparar com o fps real que o ffmpeg
    /// reporta e avisar durante a gravação — não pra montar args (quem monta é
    /// o front, gotcha #7). `None` = sem alvo, sem aviso.
    pub target_fps: Option<f64>,
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
    /// O arquivo final foi CONFERIDO com ffprobe e tem menos vídeo do que a
    /// duração prometia. É o veredito que faltava: até a v0.3 o `rec_stop`
    /// checava só se o remux deu certo, e remux de arquivo quebrado dá certo.
    pub take_degraded: bool,
    /// Quantos pacotes de vídeo o arquivo tem de verdade, e quantos eram
    /// esperados. Vai pra UI poder dizer o TAMANHO do estrago em vez de só
    /// "deu ruim" — `None` se o ffprobe não respondeu.
    pub frames: Option<u64>,
    pub frames_expected: Option<u64>,
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
    /// Guardado do start pro stop poder julgar o resultado contra o que foi pedido.
    target_fps: Option<f64>,
    /// Ligada no `rec_stop` ANTES do `q`: a partir daí, cano fechado é esperado.
    stopping: Arc<AtomicBool>,
    /// O ffmpeg recusou o PCM do cano ENQUANTO ainda se gravava.
    sys_lost: Arc<AtomicBool>,
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
    target_fps: Option<f64>,
    stopping: Arc<AtomicBool>,
    sys_lost: Arc<AtomicBool>,
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
    let app_err = app.clone();
    let stopping_c = stopping.clone();
    let sys_lost_c = sys_lost.clone();
    std::thread::spawn(move || {
        // Re-liga `mut` dentro da thread: a mutabilidade do binding de fora não
        // atravessa a captura por `move` de forma óbvia, e depender disso é
        // pedir erro de compilação que só o CI ia mostrar.
        let mut sink = sink;
        // A linha do `AcquireNextFrame failed` sai UMA vez, no instante em que a
        // captura morre. Avisar AQUI é a diferença entre o usuário perder 3
        // segundos e perder os 2 minutos que ele ainda vai gravar achando que
        // está tudo bem — foi exatamente o que aconteceu nos testes reais.
        let mut ja_avisou = false;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(f) = sink.as_mut() {
                let _ = writeln!(f, "{}", line);
            }
            if !ja_avisou && capture_lost(&line) {
                ja_avisou = true;
                let _ = app_err.emit("rec-capture-lost", ());
            }
            // O cano do áudio do sistema só conta como PERDIDO se reclamar antes
            // do stop. Depois do stop a reclamação é garantida — o cano é
            // fechado de propósito — e contá-la acenderia alarme em toda
            // gravação. Mesma lógica que o pacer já usa pro `feed`.
            if !sys_lost_c.load(Ordering::SeqCst)
                && sys_audio_line(&line)
                && !stopping_c.load(Ordering::SeqCst)
            {
                sys_lost_c.store(true, Ordering::SeqCst);
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
        // O app SEMPRE soube o fps real — mostra no rodapé desde a v0.1. O que
        // faltava era ele reagir: o take degenerado dos testes reais exibia
        // `3.21 fps` na tela enquanto a UI seguia dizendo que estava gravando.
        let mut fps_amostras: Vec<f64> = Vec::new();
        let mut ja_avisou_fps = false;
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
                    if let Some(alvo) = target_fps {
                        if let Ok(f) = p.fps.parse::<f64>() {
                            fps_amostras.push(f);
                        }
                        // Uma vez só: repetir o aviso a cada segundo viraria
                        // ruído e o usuário aprenderia a ignorar justamente o
                        // aviso que importa.
                        if !ja_avisou_fps && fps_degraded(&fps_amostras, alvo) {
                            ja_avisou_fps = true;
                            let _ = app_c.emit("rec-fps-low", p.fps.clone());
                        }
                    }
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
    mic: State<'_, crate::sysaudio::MicAudioState>,
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

    let stopping = Arc::new(AtomicBool::new(false));
    let sys_lost = Arc::new(AtomicBool::new(false));

    let (child, err, used_fallback) = match try_start(
        &app, &ffmpeg, &opts.args, &log, opts.target_fps, stopping.clone(), sys_lost.clone(),
    ) {
        Ok((c, e)) => (c, e, false),
        Err(first) => {
            // Plano B honesto: só cai no gdigrab se o ddagrab REALMENTE não
            // subiu, e avisa a UI (o usuário merece saber que está no caminho
            // lento — gdigrab custa CPU e não pega janelas com overlay).
            let Some(fb) = opts.fallback_args.clone() else {
                crate::sysaudio::stop_feed(&sys);
                crate::sysaudio::stop_feed(&mic.0);
                return Err(first);
            };
            let _ = app.emit("rec-notice", first.clone());
            // O canal do áudio do sistema morreu junto com a 1ª tentativa (o
            // named pipe vive enquanto o ffmpeg que o abriu vive). Sem refazer,
            // o plano B nasceria sem o que abrir e falharia por um motivo que
            // nada tem a ver com o gdigrab.
            // Os DOIS canos morrem com a 1ª tentativa (cada um vive enquanto
            // vive o ffmpeg que o abriu), então os dois precisam voltar.
            if let Err(e) = crate::sysaudio::restart_feed(&app, &sys) {
                crate::sysaudio::stop_feed(&sys);
                crate::sysaudio::stop_feed(&mic.0);
                return Err(format!("{} | e o canal do áudio do sistema não voltou: {}", first, e));
            }
            if let Err(e) = crate::sysaudio::restart_mic_feed(&app, &mic) {
                crate::sysaudio::stop_feed(&sys);
                crate::sysaudio::stop_feed(&mic.0);
                return Err(format!("{} | e o canal do microfone não voltou: {}", first, e));
            }
            match try_start(
                &app, &ffmpeg, &fb, &log, opts.target_fps, stopping.clone(), sys_lost.clone(),
            ) {
                Ok((c, e)) => (c, e, true),
                Err(second) => {
                    crate::sysaudio::stop_feed(&sys);
                    crate::sysaudio::stop_feed(&mic.0);
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
        target_fps: opts.target_fps,
        stopping,
        sys_lost,
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
    mic: State<'_, crate::sysaudio::MicAudioState>,
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
    // Mesma razão do `signal_feed_stop`, e ANTES dele pela mesma ordem: a partir
    // daqui, cano quebrado é o encerramento acontecendo, não falha.
    rec.stopping.store(true, Ordering::SeqCst);
    crate::sysaudio::signal_feed_stop(&sys);
    crate::sysaudio::signal_feed_stop(&mic.0);
    let graceful = graceful_stop(&mut rec.child);
    let sys_audio_error = crate::sysaudio::feed_error(&sys);
    crate::sysaudio::stop_feed(&sys);
    crate::sysaudio::stop_feed(&mic.0);

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

    // O ffmpeg recusando o PCM do cano conta como áudio do sistema perdido, mesmo
    // que o nosso lado do cano não tenha visto problema nenhum. Nos três takes de
    // 2026-07-18 07:0x foi exatamente assim: `feed_error` limpo e o take sem o som
    // do computador.
    let sys_audio_error = sys_audio_error.or_else(|| {
        rec.sys_lost
            .load(Ordering::SeqCst)
            .then(|| "o ffmpeg recusou o canal do áudio do sistema".to_string())
    });

    // O log fica quando ALGO deu errado; some quando o take saiu limpo. Guardar
    // sempre encheria a pasta de gravações de `.log` que ninguém vai ler — e
    // arquivo que sempre existe é arquivo que ninguém percebe.
    // Veredito do arquivo QUE FICOU. Roda no final (mp4 se remuxou, senão o
    // mkv) porque é esse que o usuário vai abrir — conferir o intermediário
    // provaria a coisa errada.
    let final_file = if remuxed { rec.mp4.clone() } else { rec.mkv.clone() };
    let probed = resolve_bin(&app, FFPROBE_BIN).ok().and_then(|pb| probe_video(&pb, &final_file));
    let alvo = rec.target_fps.unwrap_or(0.0);
    let (degraded, frames, frames_expected) = match probed {
        Some((n, dur)) => (
            take_degraded(n, dur, alvo),
            Some(n),
            if alvo > 0.0 { Some((dur * alvo).round() as u64) } else { None },
        ),
        // ffprobe mudo não é acusação: sem medida, não se afirma nada.
        None => (false, None, None),
    };

    let keep_log = lost || degraded || !graceful || !remuxed || sys_audio_error.is_some();
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
            take_degraded: degraded,
            frames,
            frames_expected,
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
            take_degraded: degraded,
            frames,
            frames_expected,
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
pub fn stop_on_exit(state: &RecState, sys: &SysAudioState, mic: &crate::sysaudio::MicAudioState) {
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
    // O microfone também vive num feed próprio desde que saiu do dshow: dois
    // canos, dois desligamentos.
    crate::sysaudio::stop_feed(&mic.0);
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
        // Sem saber DE QUAL entrada, a frase genérica não acusa nada — foi a
        // correção de 2026-07-18 (ver `cano_do_audio_quebrado_...`).
        assert!(!capture_lost("Error during demuxing: whatever"));
        assert!(capture_lost("[in#0/lavfi @ 0] Error during demuxing: whatever"));
    }

    #[test]
    fn cano_do_audio_quebrado_nao_e_captura_de_tela_perdida() {
        // REGRESSÃO de 2026-07-18. A primeira versão procurava a frase
        // "Error during demuxing" solta, e ela sai de QUALQUER entrada. Esta
        // linha é do take das 07:04:22, em que a tela NÃO parou (51,8 s de
        // gravação, nenhum `AcquireNextFrame` no log) — e o app teria dito na
        // cara do usuário que a captura de tela morreu.
        let so_audio = "[in#3/s16le @ 00000137c5521680] Error during demuxing: Invalid argument";
        assert!(!capture_lost(so_audio));
        // E o inverso: é o cano do áudio, e isso o app precisa saber.
        assert!(sys_audio_line(so_audio));

        // A mesma frase vinda da TELA continua contando como captura perdida.
        let da_tela = "[in#0/lavfi @ 000001c136c74cc0] Error during demuxing: Generic error in an external library";
        assert!(capture_lost(da_tela));
        assert!(!sys_audio_line(da_tela));
    }

    #[test]
    fn as_duas_falhas_juntas_sao_lidas_separadas() {
        // O log real do take das 07:03:43 tem as duas — a decisão é por LINHA,
        // senão o `in#0/` de uma casaria com a frase genérica da outra.
        let real = "[Parsed_ddagrab_0 @ 000001c1] AcquireNextFrame failed: 887a0026\n\
                    [in#0/lavfi @ 000001c1] Error during demuxing: Generic error in an external library\n\
                    [in#1/dshow @ 000001c1] real-time buffer [Integrated Camera] too full!\n\
                    [in#3/s16le @ 000001c1] Error during demuxing: Invalid argument";
        assert!(capture_lost(real));
        // A linha do cano esta no bolo, mas `sys_audio_line` e por LINHA — a
        // thread do stderr e quem a aplica, uma linha por vez.
        assert!(real.lines().any(sys_audio_line));
    }

    #[test]
    fn a_linha_do_cano_sozinha_nao_e_veredito() {
        // O ponto da correção de 2026-07-18 (segunda rodada). Esta linha sai em
        // TODA gravação com áudio do sistema, porque o `rec_stop` fecha o cano
        // de propósito antes do `q` — e o ffmpeg reclama do fechamento.
        //
        // Medido no take das 07:08:08: a faixa do sistema tinha 40,4 s contra
        // 41,0 s do mic, com silêncio digital limpo (−91 dB em 646.485
        // amostras). Nada foi perdido no meio; o cano só acabou primeiro.
        //
        // Por isso a função só RECONHECE a linha. Quem decide é a thread do
        // stderr, comparando com a flag `stopping`. Se esta função voltar a
        // decidir sozinha, todo take acende "áudio do sistema perdido".
        let linha = "[in#3/s16le @ 000002124e586340] Error during demuxing: Invalid argument";
        assert!(sys_audio_line(linha));
    }

    #[test]
    fn buffer_cheio_da_camera_nao_acusa_ninguem() {
        // A linha mais repetida dos logs reais (dezenas por take). Ela indica um
        // problema de VERDADE — a câmera não é consumida a tempo — mas não é
        // captura de tela perdida nem áudio perdido, e confundir as três faria
        // todo take com câmera acender os dois alarmes errados.
        let buf = "[in#1/dshow @ 00000137bd4b8200] real-time buffer [Integrated Camera] \
                   [video input] too full or near too full (96% of size: 128000000 \
                   [rtbufsize parameter])! frame dropped!";
        assert!(!capture_lost(buf));
        assert!(!sys_audio_line(buf));
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
    fn fps_degradado_so_com_amostras_seguidas() {
        // O caso real do take 2: 3,21 fps num alvo de 30.
        assert!(fps_degraded(&[3.21, 3.4, 3.0], 30.0));
        // Uma amostra ruim no meio de boas NÃO é degradação — máquina ocupada
        // engasga o tempo todo e avisar aqui viraria ruído.
        assert!(!fps_degraded(&[30.0, 3.0, 29.0], 30.0));
        // Nem duas: o limiar são três seguidas.
        assert!(!fps_degraded(&[30.0, 3.0, 3.0], 30.0));
        // O começo da gravação sempre tem fps baixo (encoder subindo) e não
        // pode disparar aviso antes de haver amostras suficientes.
        assert!(!fps_degraded(&[1.0, 2.0], 30.0));
        // Só as ÚLTIMAS contam: começou mal e se recuperou = tudo bem.
        assert!(!fps_degraded(&[1.0, 1.0, 1.0, 29.0, 30.0, 30.0], 30.0));
    }

    #[test]
    fn fps_degradado_respeita_o_limiar_e_o_alvo() {
        // Exatamente na metade NÃO alerta (o corte é estritamente abaixo).
        assert!(!fps_degraded(&[15.0, 15.0, 15.0], 30.0));
        assert!(fps_degraded(&[14.9, 14.9, 14.9], 30.0));
        // Alvo baixo move o limiar junto: 7 fps é ótimo pra um alvo de 10.
        assert!(!fps_degraded(&[7.0, 7.0, 7.0], 10.0));
        assert!(fps_degraded(&[4.0, 4.0, 4.0], 10.0));
        // Alvo inválido nunca alerta — sem alvo não há do que reclamar.
        assert!(!fps_degraded(&[0.0, 0.0, 0.0], 0.0));
    }

    #[test]
    fn take_degenerado_e_o_caso_real_do_joao() {
        // Take 1 dos testes reais: 115s de áudio, UM quadro de vídeo, alvo 30.
        assert!(take_degraded(1, 115.04, 30.0));
        // Take 2: 199 quadros em 53s (≈3,7 fps) — esperados ~1590.
        assert!(take_degraded(199, 53.03, 30.0));
        // Take são: 30 fps de verdade.
        assert!(!take_degraded(1590, 53.0, 30.0));
        // Perda moderada NÃO é degenerado: o veredito final é frouxo de
        // propósito, quem pega degradação leve é o alerta ao vivo.
        assert!(!take_degraded(1200, 53.0, 30.0));
    }

    #[test]
    fn take_degenerado_nao_acusa_sem_base() {
        // Sem alvo não há promessa que o arquivo possa quebrar.
        assert!(!take_degraded(1, 115.0, 0.0));
        // Take curtíssimo: o arredondamento do fps explica qualquer diferença.
        assert!(!take_degraded(0, 1.5, 30.0));
    }

    #[test]
    fn le_a_saida_do_ffprobe() {
        // Saída real: duração (decimal) e contagem (inteiro), uma por linha.
        assert_eq!(parse_probe_video("53.030000\n199\n"), Some((199, 53.03)));
        // MKV costuma não trazer duração no stream — sem ela não há veredito.
        assert_eq!(parse_probe_video("N/A\n199\n"), None);
        // Nada de útil = nada afirmado.
        assert_eq!(parse_probe_video(""), None);
        assert_eq!(parse_probe_video("53.03\n"), None);
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
