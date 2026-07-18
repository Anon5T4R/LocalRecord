//! Smoke do ÁUDIO DO SISTEMA com WASAPI e ffmpeg REAIS — a única prova que
//! vale aqui. "Compila" não diz nada sobre áudio: o modo de falha clássico é
//! justamente gravar uma faixa de áudio PERFEITA e MUDA.
//!
//! Por que é um `--example` e não `#[test]`: os testes do cargo são puros de
//! propósito (o CI não tem placa de som nem baixa ffmpeg). A prova empírica roda
//! à mão, na máquina do dev, com som tocando.
//!
//! O ponto todo é usar as funções DE PRODUÇÃO — `SysAudioFeed::start` (o mesmo
//! que o `sys_audio_start` chama), `record::spawn_ffmpeg` e
//! `record::graceful_stop` — com os args que o `src/lib/args.ts` monta de
//! verdade. Smoke que reimplementa o motor não prova nada sobre o motor.
//!
//! Uso:
//!   cargo run --example smoke_sysaudio -- <ffmpeg> <args.txt> <seg> <mkv> [remux.txt] [mp4]
//!
//! O `args.txt` sai do próprio `args.ts` (via node) com três marcadores, porque
//! o cano e o formato só existem em tempo de execução: `__PIPE__`, `__RATE__` e
//! `__AC__` — trocados aqui pelo que o dispositivo REAL informou.


// ---------------------------------------------------------------------------
// WINDOWS-ONLY, e o gate é obrigatório: este smoke usa `SysAudioFeed::start_synthetic`,
// que só existe em `sysaudio/win.rs`. O `cargo test` compila os examples em TODAS
// as plataformas, então sem isto o job Ubuntu do CI quebra com
// `E0599: no associated function named start_synthetic` — e foi o que aconteceu,
// derrubando o ci.yml em todo push desde a v0.2.0.
//
// É a MESMA armadilha do `emit_sink` (v0.2.1) e a terceira vez que ela morde:
// código Windows-only compila localmente e só o CI Linux enxerga. A diferença é
// que ali era código de produção (quebrava o AppImage) e aqui é ferramenta de
// dev — por isso o `release.yml` passava e só o `ci.yml` reclamava, o que é
// justamente o jeito mais fácil de não perceber.
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
fn main() {
    eprintln!("smoke_sysaudio: exercita WASAPI loopback — só faz sentido no Windows.");
}

#[cfg(windows)]
use std::collections::VecDeque;
#[cfg(windows)]
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use localrecord_lib::record::{graceful_stop, spawn_ffmpeg};
#[cfg(windows)]
use localrecord_lib::sysaudio::SysAudioFeed;

#[cfg(windows)]
fn read_args(path: &str) -> Vec<String> {
    let txt = std::fs::read_to_string(path).expect("ler arquivo de args");
    txt.lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(windows)]
fn size_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

#[cfg(windows)]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("uso: smoke_sysaudio [--synthetic|--mic] <ffmpeg> <args.txt> <seg> <mkv> [remux.txt] [mp4]");
        std::process::exit(2);
    }

    // 1) O feed sobe ANTES do ffmpeg: o cano tem que existir pra ele abrir.
    //    `None` no sink = sem medidor (o VU é UI; o motor não depende dela).
    //
    //    Se o 1º argumento for `--synthetic`, a captura WASAPI é trocada por um
    //    gerador de tom — o MESMO pipe + pacer + ffmpeg + stop, provados numa
    //    máquina cujo endpoint de áudio não hospeda stream (ver sysaudio/win.rs).
    let synthetic = a.get(1).map(|s| s == "--synthetic").unwrap_or(false);
    // `--mic` exercita a OUTRA ponta: o microfone, que desde a v0.6.0 entra pelo
    // mesmo cano em vez de `-f dshow -i audio=…`. A troca foi feita porque o
    // dshow de áudio derrubava a gravação inteira (o vídeo caía de 30 pra 10
    // fps, e pra 2,6 com outro microfone). Este caminho precisa ser provado
    // NÃO-MUDO: se ele falhar calado, o take sai sem microfone nenhum — que é
    // pior que o problema que ele veio resolver.
    let mic = a.get(1).map(|s| s == "--mic").unwrap_or(false);
    let shift = if synthetic || mic { 1 } else { 0 };
    let ffmpeg = PathBuf::from(&a[1 + shift]);
    let raw_args = read_args(&a[2 + shift]);
    let secs: u64 = a[3 + shift].parse().expect("segundos");
    let mkv = PathBuf::from(&a[4 + shift]);

    let (feed, info) = if synthetic {
        println!("== sys_audio_start SINTÉTICO (prova sem WASAPI) ==");
        SysAudioFeed::start_synthetic().expect("gerador sintético")
    } else if mic {
        println!("== mic_audio_start (WASAPI, entrada) ==");
        // O dispositivo vem do ambiente pra dar pra exercitar um microfone
        // ESPECÍFICO: numa máquina cujo microfone padrão não abre (acontece), o
        // `None` provaria só que o padrão está quebrado — não que o caminho está.
        let dev = std::env::var("MIC_DEV").ok().filter(|s| !s.is_empty());
        if let Some(d) = dev.as_ref() {
            println!("dispositivo pedido: {}", d);
        }
        match SysAudioFeed::start_mic(None, dev) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("SEM MICROFONE: {}", e);
                std::process::exit(1);
            }
        }
    } else {
        println!("== sys_audio_start (WASAPI loopback) ==");
        match SysAudioFeed::start(None, None) {
            Ok(v) => v,
            Err(e) => {
                // A degradação honesta, exercitada: sem saída de áudio isto DIZ
                // o motivo em vez de gravar silêncio fingindo que capturou.
                eprintln!("SEM ÁUDIO DO SISTEMA: {}", e);
                std::process::exit(1);
            }
        }
    };
    println!(
        "dispositivo: {} · {} Hz · {} canais\ncano: {}",
        info.label, info.sample_rate, info.channels, info.pipe_path
    );

    // 2) Os args vêm do args.ts; só o que não existia em tempo de build entra agora.
    let args: Vec<String> = raw_args
        .iter()
        .map(|s| {
            s.replace("__PIPE__", &info.pipe_path)
                .replace("__RATE__", &info.sample_rate.to_string())
                .replace("__AC__", &info.channels.to_string())
        })
        .collect();

    println!("== spawn: {} args, gravando {}s ==", args.len(), secs);
    let mut child = spawn_ffmpeg(&ffmpeg, &args).expect("spawn do ffmpeg");

    // Os DOIS pipes drenados em thread, igual à produção (gotcha #3: ler só um
    // trava o ffmpeg quando o outro enche o buffer do SO).
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let errs: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let errs_c = errs.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut v) = errs_c.lock() {
                v.push_back(line);
                while v.len() > 30 {
                    v.pop_front();
                }
            }
        }
    });
    let prog = std::thread::spawn(move || {
        let mut last = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_ms=") {
                last = v.to_string();
            }
        }
        last
    });

    std::thread::sleep(Duration::from_secs(secs));

    // 3) O TESTE QUE MANDA: o stop gracioso continua funcionando com o áudio
    //    ocupando um canal próprio. Se o PCM tivesse ido pro stdin, o `q` não
    //    teria por onde entrar e isto viraria kill (arquivo sem trailer).
    //
    //    ORDEM igual à do rec_stop: sinaliza o feed a parar ANTES do `q`, pra a
    //    quebra do cano no shutdown ser esperada (e não virar falso erro).
    feed.stop();
    println!("== stop gracioso: 'q' no stdin (o PCM está no pipe, não aqui) ==");
    let t0 = Instant::now();
    let graceful = graceful_stop(&mut child);
    println!(
        "stop levou {}ms · graceful={} (false = precisou de kill)",
        t0.elapsed().as_millis(),
        graceful
    );
    match feed.error() {
        Some(e) => println!("feed reclamou: {}  (NÃO deveria aparecer num stop limpo)", e),
        None => println!("feed sem erro: o stop limpo não virou falso alarme"),
    }

    if let Ok(us) = prog.join() {
        if let Ok(n) = us.parse::<i64>() {
            println!("último out_time_ms do ffmpeg: {}µs = {}ms", n, n / 1000);
        }
    }
    let tail: Vec<String> = errs.lock().map(|v| v.iter().cloned().collect()).unwrap_or_default();
    if !tail.is_empty() {
        println!("--- rabo do stderr ({} linhas guardadas) ---", tail.len());
        for l in tail.iter().take(8) {
            println!("[ffmpeg] {}", l);
        }
    }
    println!("mkv: {} bytes", size_of(&mkv));

    if a.len() >= 7 + shift {
        let remux = read_args(&a[5 + shift]);
        let mp4 = PathBuf::from(&a[6 + shift]);
        println!("== remux -c copy ==");
        let out = Command::new(&ffmpeg)
            .args(["-hide_banner", "-y", "-loglevel", "error"])
            .args(&remux)
            .stdin(Stdio::null())
            .output()
            .expect("rodar remux");
        if !out.status.success() || !mp4.exists() {
            eprintln!("remux FALHOU: {}", String::from_utf8_lossy(&out.stderr));
            println!("mkv PRESERVADO (nunca se perde um take): {}", mkv.display());
        } else {
            let _ = std::fs::remove_file(&mkv);
            println!("mp4: {} bytes · mkv apagado: {}", size_of(&mp4), !mkv.exists());
        }
    }
}
