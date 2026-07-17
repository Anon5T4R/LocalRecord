//! Smoke da onda 2 com ffmpeg REAL — prova que o motor grava e que o stop
//! gracioso entrega arquivo tocável.
//!
//! Por que é um `--example` e não um `#[test]`: os testes do cargo são PUROS de
//! propósito (o CI não baixa ffmpeg — regra do plano). Este aqui precisa do
//! binário de verdade, então roda à mão, na máquina do dev.
//!
//! O ponto todo é chamar as funções DE PRODUÇÃO (`record::spawn_ffmpeg` e
//! `record::graceful_stop`) com os args que o front monta de verdade — smoke que
//! reimplementa o motor não prova nada sobre o motor.
//!
//! Uso:
//!   cargo run --example smoke_record -- <ffmpeg> <args.txt> <seg> <graceful|kill> <mkv> [remux.txt] [mp4]
//! (args.txt / remux.txt = um argumento do ffmpeg por linha, gerados pelo
//!  próprio `src/lib/args.ts` via node — ver o comando no relatório da onda.)

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use localrecord_lib::record::{graceful_stop, spawn_ffmpeg};

fn read_args(path: &str) -> Vec<String> {
    let txt = std::fs::read_to_string(path).expect("ler arquivo de args");
    txt.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty()).map(String::from).collect()
}

fn size_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 6 {
        eprintln!("uso: smoke_record <ffmpeg> <args.txt> <seg> <graceful|kill> <mkv> [remux.txt] [mp4]");
        std::process::exit(2);
    }
    let ffmpeg = PathBuf::from(&a[1]);
    let args = read_args(&a[2]);
    let secs: u64 = a[3].parse().expect("segundos");
    let mode = a[4].clone();
    let mkv = PathBuf::from(&a[5]);

    println!("== spawn: {} args, gravando {}s ==", args.len(), secs);
    let mut child = spawn_ffmpeg(&ffmpeg, &args).expect("spawn do ffmpeg");

    // Os DOIS pipes drenados em thread, igual à produção: ler só um trava o
    // ffmpeg quando o outro enche o buffer do SO (gotcha #3).
    //
    // E o stderr vai pra um ANEL EM MEMÓRIA, não pro terminal — exatamente como
    // a produção faz. Não é capricho: a 1ª versão deste smoke reimprimia cada
    // linha com eprintln! e, quando a saída do exemplo era canalizada (`| grep`),
    // a contrapressão do pipe travava a thread de drenagem → o stderr do ffmpeg
    // enchia → o ffmpeg inteiro parava (a câmera ia a 97% de buffer e a gravação
    // saía com 0 byte). Ou seja: o gotcha #3 mordeu o próprio smoke. O anel
    // limitado nunca depende de quem consome lá na frente — é por isso que a
    // produção não tem esse problema.
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
            // O mesmo `-progress pipe:1` que alimenta o evento rec-progress.
            if let Some(v) = line.strip_prefix("out_time_ms=") {
                last = v.to_string();
            }
        }
        last
    });

    std::thread::sleep(Duration::from_secs(secs));

    let t0 = Instant::now();
    let graceful = if mode == "kill" {
        // Contraste deliberado: é isto que a gente NÃO quer fazer.
        println!("== kill() cru (o caminho errado, pra comparar) ==");
        let _ = child.kill();
        let _ = child.wait();
        false
    } else {
        println!("== stop gracioso: 'q' no stdin ==");
        graceful_stop(&mut child)
    };
    println!(
        "stop levou {}ms · graceful={} (false = precisou de kill)",
        t0.elapsed().as_millis(),
        graceful
    );

    if let Ok(us) = prog.join() {
        if let Ok(n) = us.parse::<i64>() {
            // µs → ms, o gotcha #1.
            println!("último out_time_ms do ffmpeg: {}µs = {}ms", n, n / 1000);
        }
    }
    let tail: Vec<String> = errs.lock().map(|v| v.iter().cloned().collect()).unwrap_or_default();
    if !tail.is_empty() {
        println!("--- rabo do stderr ({} linhas guardadas) ---", tail.len());
        for l in tail.iter().take(5) {
            println!("[ffmpeg] {}", l);
        }
    }
    println!("mkv: {} bytes", size_of(&mkv));

    // Remux MKV→MP4, o mesmo passo do rec_stop.
    if a.len() >= 8 {
        let remux = read_args(&a[6]);
        let mp4 = PathBuf::from(&a[7]);
        println!("== remux -c copy ==");
        let out = Command::new(&ffmpeg)
            .args(["-hide_banner", "-y", "-loglevel", "error"])
            .args(&remux)
            .stdin(Stdio::null())
            .output()
            .expect("rodar remux");
        let ok = out.status.success() && mp4.exists();
        if !ok {
            eprintln!("remux FALHOU: {}", String::from_utf8_lossy(&out.stderr));
            println!("mkv PRESERVADO (nunca se perde um take): {}", mkv.display());
        } else {
            // Só agora o MKV sai — igual ao rec_stop.
            let _ = std::fs::remove_file(&mkv);
            println!("mp4: {} bytes · mkv apagado: {}", size_of(&mp4), !mkv.exists());
        }
    }
}
