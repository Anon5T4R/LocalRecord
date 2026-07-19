//! Ponta a ponta REAL: os dois feeds WASAPI (mic + sistema) + ffmpeg com os
//! args do `buildRecordArgs` + stop gracioso — o pipeline inteiro da gravação,
//! sem UI. O veredito do áudio sai depois, medindo o arquivo com `astats`.
//!
//! Difere do `smoke_sysaudio` porque exercita os DOIS canos ao mesmo tempo (o
//! cenário do bug relatado: mic presente, sistema mudo) e aceita os marcadores
//! dos dois formatos.
//!
//! Uso: debug_e2e <ffmpeg> <args.txt> <segundos> [--no-mic]

#[cfg(not(windows))]
fn main() {
    eprintln!("debug_e2e: WASAPI — só faz sentido no Windows.");
}

#[cfg(windows)]
fn main() {
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::time::Duration;

    use localrecord_lib::record::{graceful_stop, spawn_ffmpeg};
    use localrecord_lib::sysaudio::SysAudioFeed;

    let a: Vec<String> = std::env::args().collect();
    let ffmpeg = PathBuf::from(&a[1]);
    let raw = std::fs::read_to_string(&a[2]).expect("args.txt");
    let secs: u64 = a[3].parse().expect("segundos");
    let no_mic = a.get(4).map(|s| s == "--no-mic").unwrap_or(false);

    let (sys_feed, sys) = SysAudioFeed::start(None, None).expect("sys_audio_start");
    println!("sys: {} · {} Hz · {} ch", sys.label, sys.sample_rate, sys.channels);
    let mic = if no_mic {
        None
    } else {
        // MIC_DEV pra exercitar um microfone específico (ex.: o do fone BT, que
        // flipa o perfil A2DP→HFP e pode calar o render do MESMO aparelho).
        match SysAudioFeed::start_mic(None, std::env::var("MIC_DEV").ok().filter(|s| !s.is_empty())) {
            Ok((f, i)) => {
                println!("mic: {} · {} Hz · {} ch", i.label, i.sample_rate, i.channels);
                Some((f, i))
            }
            Err(e) => {
                println!("mic NÃO subiu ({}) — seguindo só com o sistema", e);
                None
            }
        }
    };

    let args: Vec<String> = raw
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty())
        .map(|s| {
            let mut s = s
                .replace("__SYSPIPE__", &sys.pipe_path)
                .replace("__SYSRATE__", &sys.sample_rate.to_string())
                .replace("__SYSAC__", &sys.channels.to_string());
            if let Some((_, i)) = mic.as_ref() {
                s = s
                    .replace("__MICPIPE__", &i.pipe_path)
                    .replace("__MICRATE__", &i.sample_rate.to_string())
                    .replace("__MICAC__", &i.channels.to_string());
            }
            s
        })
        .collect();

    println!("== ffmpeg, {}s ==", secs);
    let mut child = spawn_ffmpeg(&ffmpeg, &args).expect("spawn");
    let stderr = child.stderr.take().expect("stderr");
    let eh = std::thread::spawn(move || {
        let mut all = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            all.push(line);
        }
        all
    });
    let stdout = child.stdout.take().expect("stdout");
    std::thread::spawn(move || for _ in BufReader::new(stdout).lines() {});

    std::thread::sleep(Duration::from_secs(secs));
    // A ORDEM do rec_stop: sinaliza os feeds ANTES do `q`.
    sys_feed.stop();
    if let Some((f, _)) = mic.as_ref() {
        f.stop();
    }
    let graceful = graceful_stop(&mut child);
    println!("graceful={}", graceful);
    match sys_feed.error() {
        Some(e) => println!("sys feed ERRO: {}", e),
        None => println!("sys feed sem erro"),
    }
    println!("sys starved (take mudo de ponta a ponta): {}", sys_feed.starved());
    if let Some((f, _)) = mic.as_ref() {
        match f.error() {
            Some(e) => println!("mic feed ERRO: {}", e),
            None => println!("mic feed sem erro"),
        }
    }
    for l in eh.join().unwrap_or_default() {
        println!("[ffmpeg] {}", l);
    }
}
