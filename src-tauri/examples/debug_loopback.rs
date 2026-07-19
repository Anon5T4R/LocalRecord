//! Mede o PCM que REALMENTE sai do cano do áudio do sistema — sem ffmpeg.
//!
//! O `smoke_sysaudio` prova que o cano + pacer + ffmpeg + stop funcionam, mas o
//! arquivo que ele grava não diz se o PCM tinha SOM: uma faixa perfeita e muda
//! passa por todos os portões. Este harness fecha esse buraco: sobe o feed pelo
//! MESMO `SysAudioFeed::start` da produção, abre o cano como cliente (o papel
//! do ffmpeg) e mede RMS, pico e cruzamentos de zero do que chegou.
//!
//! Uso (com um tom tocando na saída padrão, e depois sem, pra baseline):
//!   cargo run --example debug_loopback -- [segundos]
//!   SYS_DEV="Nome da saída" pra pedir um endpoint específico.

#[cfg(not(windows))]
fn main() {
    eprintln!("debug_loopback: WASAPI loopback — só faz sentido no Windows.");
}

#[cfg(windows)]
fn main() {
    use std::io::Read;
    use std::time::Duration;

    use localrecord_lib::sysaudio::SysAudioFeed;

    // `--list`: só enumera as saídas (a padrão primeiro), sem capturar nada.
    if std::env::args().nth(1).as_deref() == Some("--list") {
        for d in localrecord_lib::sysaudio::list_outputs() {
            println!("saída: {}", d.label);
        }
        return;
    }

    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(3);
    let dev = std::env::var("SYS_DEV").ok().filter(|s| !s.is_empty());

    let (feed, info) = match SysAudioFeed::start(None, dev) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("sys_audio_start FALHOU: {}", e);
            std::process::exit(1);
        }
    };
    println!(
        "dispositivo: {} · {} Hz · {} canais · cano: {}",
        info.label, info.sample_rate, info.channels, info.pipe_path
    );

    // O papel do ffmpeg: cliente do cano, lendo s16le cru.
    let pipe = info.pipe_path.clone();
    let reader = std::thread::spawn(move || {
        let mut f = std::fs::File::open(&pipe).expect("abrir o cano como cliente");
        let mut buf = [0u8; 8192];
        let mut samples: Vec<i16> = Vec::new();
        loop {
            match f.read(&mut buf) {
                Ok(0) | Err(_) => break, // servidor desconectou = fim do teste
                Ok(n) => {
                    for c in buf[..n].chunks_exact(2) {
                        samples.push(i16::from_le_bytes([c[0], c[1]]));
                    }
                }
            }
        }
        samples
    });

    std::thread::sleep(Duration::from_secs(secs));
    feed.stop();
    let samples = reader.join().expect("thread de leitura");

    let n = samples.len();
    let nonzero = samples.iter().filter(|&&s| s != 0).count();
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    let rms = (sum_sq / n.max(1) as f64).sqrt();
    let dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { f64::NEG_INFINITY };
    let peak = samples.iter().map(|s| (*s as i32).abs()).max().unwrap_or(0);
    let zc = samples.windows(2).filter(|w| (w[0] < 0) != (w[1] < 0)).count();
    let dur_s = n as f64 / (info.sample_rate as f64 * info.channels as f64);

    println!(
        "amostras: {} ({:.2}s) · não-zero: {} ({:.1}%)",
        n,
        dur_s,
        nonzero,
        100.0 * nonzero as f64 / n.max(1) as f64
    );
    println!("RMS: {:.6} ({:.1} dBFS) · pico: {} · cruzamentos de zero: {}", rms, dbfs, peak, zc);
    match feed.error() {
        Some(e) => println!("feed ERRO: {}", e),
        None => println!("feed sem erro"),
    }
    // O veredito novo: o take inteiro passou sem UM pacote real da placa?
    println!("starved (fome de pacote real): {}", feed.starved());
}
