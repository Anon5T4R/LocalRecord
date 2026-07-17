//! Infra do ffmpeg embarcado (binaries/ffmpeg) — peças compartilhadas.
//!
//! Onda 1 traz só o que é agnóstico de job: achar o binário, não piscar console
//! no Windows, ler o progresso ESTRUTURADO (`-progress pipe:1`) e o registro de
//! processos vivos (pra cancelar e pra não deixar ffmpeg órfão na saída).
//!
//! O motor de gravação em si é da onda 2. Vale a diferença herdada do LocalMedia:
//! lá o job é converte-arquivo-e-espera (`ff_run` bloqueia até o processo sair);
//! gravação é long-running com handle — `rec_start` retorna na hora e `rec_stop`
//! precisa ser gracioso (`q` no stdin, NUNCA `kill()`, senão o arquivo fica sem
//! índice/trailer). Por isso `FfState` já nasce guardando `Child` por id.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, State};

/// Processos do ffmpeg vivos, por id (gravação, remux…).
#[derive(Default)]
pub struct FfState {
    pub jobs: Mutex<HashMap<String, Child>>,
}

pub const FFMPEG_BIN: &str = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
pub const FFPROBE_BIN: &str = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };

/// Localiza um binário embarcado. Dev: cwd/binaries/ffmpeg. Prod: resource dir.
pub fn resolve_bin(app: &tauri::AppHandle, bin: &str) -> Result<PathBuf, String> {
    let rel = format!("binaries/ffmpeg/{}", bin);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(&rel));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(&rel));
        candidates.push(res.join(format!("ffmpeg/{}", bin)));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&rel));
            candidates.push(dir.join(format!("ffmpeg/{}", bin)));
        }
    }
    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }
    Err(format!("{} não encontrado (runtime de mídia ausente)", bin))
}

pub fn no_window(cmd: &mut Command) {
    // Não abre janela de console no Windows (CREATE_NO_WINDOW). Sem isso, um
    // console preto pisca a cada chamada — e a gravação chama muito.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd; // no Linux não há o que fazer
}

/// O runtime está presente? (a UI avisa se não estiver)
#[tauri::command(async)]
pub fn ffmpeg_ok(app: tauri::AppHandle) -> bool {
    resolve_bin(&app, FFMPEG_BIN).is_ok() && resolve_bin(&app, FFPROBE_BIN).is_ok()
}

/// Interpreta uma linha do `-progress pipe:1`. Atenção histórica do ffmpeg:
/// `out_time_ms` vem em MICROSSEGUNDOS (nome mantido por compatibilidade) —
/// quem consome divide por 1000.
///
/// Quem consome é a thread de progresso do `rec_start` (record.rs): cada bloco
/// do `-progress` termina em `progress=`, e é aí que a UI recebe o retrato.
pub fn parse_progress_line(line: &str) -> Option<(&str, String)> {
    let (k, v) = line.split_once('=')?;
    match k.trim() {
        "out_time_ms" | "out_time_us" => Some(("t", v.trim().to_string())),
        "fps" => Some(("fps", v.trim().to_string())),
        "speed" => Some(("speed", v.trim().to_string())),
        "total_size" => Some(("size", v.trim().to_string())),
        "progress" => Some(("progress", v.trim().to_string())),
        _ => None,
    }
}

/// Cancela um job em andamento (mata o ffmpeg dele).
///
/// ATENÇÃO onda 2: isto é cancelamento BRUTO — serve pra descartar. Parar uma
/// gravação de verdade é `rec_stop` (manda `q` no stdin e espera o trailer).
#[tauri::command(async)]
pub fn ff_cancel(state: State<'_, FfState>, job_id: String) {
    if let Ok(mut jobs) = state.jobs.lock() {
        if let Some(child) = jobs.get_mut(&job_id) {
            let _ = child.kill();
        }
    }
}

/// Mata qualquer ffmpeg vivo (chamado no `RunEvent::Exit` — não deixar órfão).
pub fn kill_all(state: &FfState) {
    if let Ok(mut jobs) = state.jobs.lock() {
        for (_, child) in jobs.iter_mut() {
            let _ = child.kill();
        }
        jobs.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progresso_estruturado() {
        assert_eq!(
            parse_progress_line("out_time_ms=1500000"),
            Some(("t", "1500000".to_string()))
        );
        assert_eq!(parse_progress_line("out_time_us=250000"), Some(("t", "250000".to_string())));
        assert_eq!(parse_progress_line("speed=2.31x"), Some(("speed", "2.31x".to_string())));
        assert_eq!(parse_progress_line("fps=30.02"), Some(("fps", "30.02".to_string())));
        assert_eq!(parse_progress_line("total_size=4096"), Some(("size", "4096".to_string())));
        assert_eq!(
            parse_progress_line("progress=continue"),
            Some(("progress", "continue".to_string()))
        );
        // Chave que não interessa e linha sem `=` são ignoradas (não explodem).
        assert_eq!(parse_progress_line("frame=123"), None);
        assert_eq!(parse_progress_line("sem igual"), None);
    }

    #[test]
    fn out_time_ms_e_microssegundos() {
        // O gotcha #1 da suíte, cravado em teste: 1.500.000 µs = 1500 ms.
        let (_, v) = parse_progress_line("out_time_ms=1500000").unwrap();
        assert_eq!(v.parse::<i64>().unwrap() / 1000, 1500);
    }
}
