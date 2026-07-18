//! Enumeração de fontes de captura (telas, câmeras, microfones).
//!
//! EXCEÇÃO CONSCIENTE À REGRA "nunca faça regex no log humano do ffmpeg":
//! o `-list_devices true -f dshow -i dummy` **não tem saída estruturada** — o
//! ffmpeg imprime a lista no stderr e sai com erro de propósito (o `dummy` não
//! existe). Não há `-print_format json` pra dshow. Então aqui a gente parseia
//! o texto MESMO, e só aqui. A regra continua valendo pro resto (progresso =
//! `-progress pipe:1`, sondagem = `ffprobe -print_format json`).
//!
//! Onda 2 usa os `id` daqui direto nos args do ffmpeg (`-f dshow -i video=<id>`),
//! por isso o `id` é o nome CRU do dispositivo, sem tradução nem normalização.

use serde::Serialize;

// Só o caminho Windows fala com o ffmpeg (dshow); no Linux a enumeração é
// leitura de /dev — daí os imports serem cfg-gated (senão viram warning lá).
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use crate::ffmpeg::{no_window, resolve_bin, FFMPEG_BIN};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Nome cru como o ffmpeg quer receber de volta (`video=<id>`).
    pub id: String,
    /// Rótulo pra UI. Hoje = `id`; existe separado porque a tela sintética
    /// (e, na onda 2, os monitores por índice) precisa de rótulo próprio.
    pub label: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub screens: Vec<Device>,
    pub cameras: Vec<Device>,
    pub microphones: Vec<Device>,
    /// Saídas de áudio — a fonte do áudio DO SISTEMA (WASAPI loopback: a gente
    /// grava o que sai por elas). Não vêm do dshow como o resto: quem enumera é
    /// o cpal, no `sysaudio` (a lista do dshow só mostra "Mixagem estéreo"
    /// quando o fabricante deixou, que é o problema que o loopback resolve).
    pub outputs: Vec<Device>,
}

/// Tipo de dispositivo dshow, como o ffmpeg classifica.
/// (`test` no cfg: no Linux o parser não tem chamador fora dos testes.)
#[cfg(any(windows, test))]
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Video,
    Audio,
}

/// Parser da listagem dshow (ver a nota de exceção no topo do módulo).
///
/// O ffmpeg mudou o formato ao longo das versões e a gente aguenta os dois:
///  - moderno: `[dshow @ ...] "Nome da Câmera" (video)`
///  - antigo:  cabeçalho `DirectShow video devices` e depois só `"Nome"`
/// A linha `Alternative name "@device_pnp_..."` é ignorada (é o id longo; o
/// nome amigável basta e é o que o usuário reconhece).
#[cfg(any(windows, test))]
fn parse_dshow_devices(stderr: &str) -> (Vec<Device>, Vec<Device>) {
    let mut cameras = Vec::new();
    let mut mics = Vec::new();
    // Seção corrente (formato antigo). None até bater um cabeçalho.
    let mut section: Option<Kind> = None;

    for line in stderr.lines() {
        let line = line.trim();
        // Tira o prefixo `[dshow @ 0x...]` pra sobrar só o conteúdo.
        let body = match line.find(']') {
            Some(i) if line.starts_with('[') => line[i + 1..].trim(),
            _ => line,
        };

        if body.contains("DirectShow video devices") {
            section = Some(Kind::Video);
            continue;
        }
        if body.contains("DirectShow audio devices") {
            section = Some(Kind::Audio);
            continue;
        }
        // O id longo — não serve de nome.
        if body.starts_with("Alternative name") {
            continue;
        }

        // Nome entre aspas: `"Nome"` ou `"Nome" (video)`.
        let Some(rest) = body.strip_prefix('"') else { continue };
        let Some(end) = rest.find('"') else { continue };
        let name = &rest[..end];
        if name.is_empty() {
            continue;
        }
        let tail = rest[end + 1..].trim();

        // O sufixo explícito manda; sem ele, cai na seção do cabeçalho.
        let kind = if tail.contains("(video)") {
            Some(Kind::Video)
        } else if tail.contains("(audio)") {
            Some(Kind::Audio)
        } else {
            section
        };

        let dev = Device { id: name.to_string(), label: name.to_string() };
        match kind {
            Some(Kind::Video) => cameras.push(dev),
            Some(Kind::Audio) => mics.push(dev),
            None => {} // fora de seção e sem sufixo: não dá pra classificar
        }
    }
    (cameras, mics)
}

/// Roda o `-list_devices` e devolve o stderr. Sai com erro de propósito (o
/// input `dummy` não existe) — então o status é ignorado, o que importa é o texto.
#[cfg(windows)]
fn dshow_stderr(app: &tauri::AppHandle) -> Result<String, String> {
    let ffmpeg = resolve_bin(app, FFMPEG_BIN)?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("falha ao rodar ffmpeg: {}", e))?;
    Ok(String::from_utf8_lossy(&out.stderr).to_string())
}

/// Telas disponíveis.
///
/// ONDA 1: uma entrada sintética "tela principal" e pronto. Enumerar monitor a
/// monitor custa API de plataforma (EnumDisplayMonitors no Windows, XRandR no
/// Linux) e a onda 1 não grava nada — não paga a conta ainda. A onda 2 troca
/// isto por monitores de verdade: o `ddagrab` indexa por `output` e o `x11grab`
/// por offset `+X,+Y`, então o `id` vira o índice/offset e o `label` o nome do
/// monitor. O `id` "primary" é o contrato provisório.
fn primary_screen() -> Vec<Device> {
    vec![Device { id: "primary".to_string(), label: "primary".to_string() }]
}

/// Câmeras via v4l2: os `/dev/video*` que existem.
///
/// Só os nós, sem ler capability — um `/dev/videoN` pode ser saída de metadados
/// e não câmera. A onda 2 filtra de verdade (ioctl VIDIOC_QUERYCAP) quando for
/// abrir o dispositivo; pra escolher na lista, o nó basta.
#[cfg(not(windows))]
fn v4l2_cameras() -> Vec<Device> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/dev") else { return out };
    let mut paths: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path().to_string_lossy().to_string())
        .filter(|p| {
            p.strip_prefix("/dev/video").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        })
        .collect();
    paths.sort();
    for p in paths {
        out.push(Device { id: p.clone(), label: p });
    }
    out
}

/// Um modo que a câmera realmente oferece.
///
/// Existe por causa dos testes reais de 2026-07-18: sem modo explícito, o dshow
/// escolhe sozinho — e o log encheu de `real-time buffer [Integrated Camera]
/// too full` até 96 %, com a gravação inteira caindo pra 2,7 fps. **Medi aqui
/// que nem o grafo nem o encoder são o gargalo** (tela + câmera sintética 1080p
/// + `overlay` + `h264_amf` deram 29,6 fps em duas rodadas), então o que sobra é
/// o modo que o dispositivo entrega.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CamMode {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// `mjpeg` etc. quando o modo é comprimido; `None` = pixel format cru.
    pub vcodec: Option<String>,
    /// `yuyv422` etc. quando é cru; `None` = comprimido.
    pub pixel_format: Option<String>,
}

/// Lê a saída do `-list_options true`. Pura pra ser testável sem câmera.
///
/// As linhas reais têm esta cara (uma por modo):
/// ```text
/// [dshow @ ...]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30
/// [dshow @ ...]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
/// ```
/// O `max` é o que interessa: é o teto real daquele modo.
fn parse_cam_modes(stderr: &str) -> Vec<CamMode> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        // `max s=` porque o `min` do mesmo modo repetiria tudo com fps inútil.
        let Some(max) = line.split("max s=").nth(1) else { continue };
        let mut it = max.split_whitespace();
        let Some(size) = it.next() else { continue };
        let (w, h) = size.split_once('x').unwrap_or(("", ""));
        let (Ok(width), Ok(height)) = (w.parse::<u32>(), h.parse::<u32>()) else { continue };
        let fps = it
            .find_map(|t| t.strip_prefix("fps="))
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);

        let campo = |chave: &str| {
            line.split(chave)
                .nth(1)
                .and_then(|r| r.split_whitespace().next())
                .map(|s| s.to_string())
        };
        out.push(CamMode {
            width,
            height,
            fps,
            vcodec: campo("vcodec="),
            pixel_format: campo("pixel_format="),
        });
    }
    out
}

/// Os modos que uma câmera oferece. Lista vazia = não deu pra descobrir (e aí o
/// front não força modo nenhum, que é o comportamento antigo).
#[tauri::command(async)]
pub fn camera_modes(app: tauri::AppHandle, id: String) -> Result<Vec<CamMode>, String> {
    #[cfg(windows)]
    {
        let ffmpeg = resolve_bin(&app, FFMPEG_BIN)?;
        let mut cmd = Command::new(&ffmpeg);
        // Sai com erro de propósito, igual ao `-list_devices`: o que importa é
        // o texto no stderr, não o status.
        cmd.args(["-hide_banner", "-list_options", "true", "-f", "dshow", "-i"])
            .arg(format!("video={}", id))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        no_window(&mut cmd);
        let out = cmd.output().map_err(|e| format!("falha ao rodar ffmpeg: {}", e))?;
        Ok(parse_cam_modes(&String::from_utf8_lossy(&out.stderr)))
    }

    #[cfg(not(windows))]
    {
        // v4l2 não tem o mesmo `-list_options`; no Linux o modo segue automático.
        let _ = (&app, &id);
        Ok(Vec::new())
    }
}

/// Lista telas, câmeras e microfones pra UI escolher a fonte.
#[tauri::command(async)]
pub fn list_devices(app: tauri::AppHandle) -> Result<DeviceList, String> {
    let screens = primary_screen();
    let outputs = crate::sysaudio::list_outputs();

    #[cfg(windows)]
    {
        let stderr = dshow_stderr(&app)?;
        let (cameras, microphones) = parse_dshow_devices(&stderr);
        Ok(DeviceList { screens, cameras, microphones, outputs })
    }

    #[cfg(not(windows))]
    {
        let _ = &app;
        // STUB de áudio no Linux: enumerar PulseAudio/ALSA de verdade pede
        // `pactl list sources` (ou libpulse). Fica junto com o áudio do sistema
        // no Linux (monitor do pulse), que também está pendente; por ora, o
        // default do pulse cobre o caso comum. `outputs` vem VAZIA — e vazia a
        // UI diz "não dá pra capturar o áudio do sistema aqui", que é a verdade.
        let microphones = vec![Device { id: "default".to_string(), label: "default".to_string() }];
        Ok(DeviceList { screens, cameras: v4l2_cameras(), microphones, outputs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Amostra real do `-list_options` de uma webcam integrada.
    const SAMPLE_MODES: &str = r#"
[dshow @ 000001f9] DirectShow video device options (from video devices)
[dshow @ 000001f9]  Pin "Captura" (alternative pin name "0")
[dshow @ 000001f9]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
[dshow @ 000001f9]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=5
[dshow @ 000001f9]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30
"#;

    #[test]
    fn le_os_modos_da_camera() {
        let m = parse_cam_modes(SAMPLE_MODES);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0], CamMode { width: 640, height: 480, fps: 30.0,
            vcodec: None, pixel_format: Some("yuyv422".into()) });
        // O caso que explica o bug real: 1080p CRU so entrega 5 fps. Pedir 30
        // nesse modo e pedir o impossivel — e foi o que o app fez ate a v0.4.1,
        // deixando o dshow escolher.
        assert_eq!(m[1].fps, 5.0);
        assert_eq!(m[1].width, 1920);
        assert_eq!(m[2], CamMode { width: 1280, height: 720, fps: 30.0,
            vcodec: Some("mjpeg".into()), pixel_format: None });
    }

    #[test]
    fn linhas_que_nao_sao_modo_sao_ignoradas() {
        assert!(parse_cam_modes("").is_empty());
        assert!(parse_cam_modes("[dshow @ 0] DirectShow video device options").is_empty());
        // Tamanho quebrado nao vira modo com zero — vira modo nenhum.
        assert!(parse_cam_modes("[dshow @ 0]  max s=axb fps=30").is_empty());
    }

    /// Amostra real do formato moderno (ffmpeg 6/7), com o `(video)`/`(audio)`.
    const SAMPLE_MODERNO: &str = r#"
[dshow @ 000001f9a1b2c3d0] "Integrated Camera" (video)
[dshow @ 000001f9a1b2c3d0]   Alternative name "@device_pnp_\\?\usb#vid_04f2&pid_b6d9&mi_00#6&1e2f3a4b&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[dshow @ 000001f9a1b2c3d0] "OBS Virtual Camera" (video)
[dshow @ 000001f9a1b2c3d0]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 000001f9a1b2c3d0] "Microfone (Realtek(R) Audio)" (audio)
[dshow @ 000001f9a1b2c3d0]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{E6327CAB-1234-4321-9876-0011223344AA}"
[dshow @ 000001f9a1b2c3d0] "Mixagem estéreo (Realtek(R) Audio)" (audio)
dummy: Immediate exit requested
"#;

    /// Formato antigo: sem sufixo, classificado pelo cabeçalho da seção.
    const SAMPLE_ANTIGO: &str = r#"
[dshow @ 0000023f] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000023f]  "Integrated Camera"
[dshow @ 0000023f]     Alternative name "@device_pnp_\\?\usb#vid_04f2"
[dshow @ 0000023f] DirectShow audio devices
[dshow @ 0000023f]  "Microphone (HD Webcam)"
[dshow @ 0000023f]     Alternative name "@device_cm_{33D9A762}"
dummy: Immediate exit requested
"#;

    #[test]
    fn dshow_formato_moderno() {
        let (cams, mics) = parse_dshow_devices(SAMPLE_MODERNO);
        assert_eq!(
            cams.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["Integrated Camera", "OBS Virtual Camera"]
        );
        assert_eq!(
            mics.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["Microfone (Realtek(R) Audio)", "Mixagem estéreo (Realtek(R) Audio)"]
        );
        // O id tem que sair CRU — é o que volta pro ffmpeg como `video=<id>`.
        assert_eq!(cams[0].label, cams[0].id);
    }

    #[test]
    fn dshow_formato_antigo_usa_cabecalho() {
        let (cams, mics) = parse_dshow_devices(SAMPLE_ANTIGO);
        assert_eq!(cams.len(), 1);
        assert_eq!(cams[0].id, "Integrated Camera");
        assert_eq!(mics.len(), 1);
        assert_eq!(mics[0].id, "Microphone (HD Webcam)");
    }

    #[test]
    fn dshow_ignora_alternative_name_e_lixo() {
        // O "Alternative name" também vem entre aspas — se vazasse, viraria
        // dispositivo fantasma na lista. É o erro clássico deste parser.
        let (cams, mics) = parse_dshow_devices(SAMPLE_MODERNO);
        assert!(!cams.iter().any(|d| d.id.starts_with("@device")));
        assert!(!mics.iter().any(|d| d.id.starts_with("@device")));

        let (c, m) = parse_dshow_devices("nada aqui\n[dshow @ 1] sem aspas\n");
        assert!(c.is_empty() && m.is_empty());
        let (c, m) = parse_dshow_devices("");
        assert!(c.is_empty() && m.is_empty());
    }

    #[test]
    fn tela_principal_e_o_contrato_provisorio() {
        let s = primary_screen();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].id, "primary");
    }
}
