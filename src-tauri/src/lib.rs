//! LocalRecord — estúdio de captura de tela 100% offline da suíte Local.
//!
//! ONDA 3 (esta): o PILAR — overlay de anotação ao vivo (`annot.rs`) + atalhos
//! globais, sobre a infra do ffmpeg (onda 1) e o motor de gravação (onda 2:
//! start que volta na hora, stop gracioso, remux MKV→MP4).
//!
//! Divisão de trabalho da suíte (gotcha #7): os ARGUMENTOS de cada job do
//! ffmpeg se montam no front (TS puro, unit-testado); o Rust só resolve o
//! binário e move bytes.

pub mod annot;
mod devices;
mod ffmpeg;
// Áudio do sistema (WASAPI loopback) + medidores de nível. `pub` pelo mesmo
// motivo do `record`: o `examples/smoke_sysaudio.rs` exercita o feed de verdade.
pub mod sysaudio;
// `pub` pro `examples/smoke_record.rs` alcançar o `spawn_ffmpeg`/`graceful_stop`
// e gravar de verdade com ffmpeg real — os testes do cargo são puros de
// propósito (não baixam binário), então a prova empírica mora no example.
pub mod record;

use tauri::Manager;

use annot::AnnotState;
use ffmpeg::FfState;
use record::RecState;
use sysaudio::{MonitorState, SysAudioState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }))
            // Sem `.with_shortcuts()`: quem registra é o `annot_arm`, e só
            // enquanto o overlay está armado. Prender atalho global desde o
            // boot roubaria a combinação de todo mundo por nada.
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .manage(FfState::default())
        .manage(RecState::default())
        .manage(AnnotState::default())
        .manage(SysAudioState::default())
        .manage(MonitorState::default())
        .invoke_handler(tauri::generate_handler![
            ffmpeg::ffmpeg_ok,
            ffmpeg::ff_cancel,
            devices::list_devices,
            devices::camera_modes,
            sysaudio::sys_audio_probe,
            sysaudio::sys_audio_start,
            sysaudio::sys_audio_stop,
            sysaudio::audio_monitor_start,
            sysaudio::audio_monitor_stop,
            record::rec_start,
            record::rec_stop,
            record::rec_status,
            record::rec_pick_encoder,
            record::rec_default_dir,
            record::rec_screen_thumb,
            record::unique_path,
            annot::annot_arm,
            annot::annot_set_pen,
            annot::annot_state,
            annot::annot_clear,
            annot::annot_focus
        ])
        .on_window_event(|win, event| {
            // A `annot` existe desde o boot (escondida). Sem isto, fechar a
            // janela principal NÃO fecharia o app: o Tauri só sai quando a
            // última janela some, e sobraria um LocalRecord invisível vivo,
            // segurando os atalhos globais.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if win.label() == "main" {
                    win.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Antes de tudo: devolver os atalhos globais pro sistema.
                annot::release_on_exit(app);
                // ORDEM IMPORTA. Primeiro a gravação, e com `q` + espera: fechar
                // o app não pode custar o take do usuário. Só depois o `kill_all`
                // varre o resto (remux/sonda), que é descartável — matar aqueles
                // não perde nada, matar a gravação perderia o trailer do arquivo.
                record::stop_on_exit(&app.state::<RecState>(), &app.state::<SysAudioState>());
                ffmpeg::kill_all(&app.state::<FfState>());
            }
        });
}
