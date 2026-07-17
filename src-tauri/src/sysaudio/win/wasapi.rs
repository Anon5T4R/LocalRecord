//! WASAPI cru (crate `windows`) para captura de loopback e de microfone, em
//! modo POLLING. O PORQUÊ de ser polling e não `cpal`/evento está no topo do
//! `win.rs`; aqui é o COM.
//!
//! Tudo neste módulo roda na thread de captura (o `spawn_capture` do pai): os
//! ponteiros COM são apartment-bound, então nascem, são lidos e morrem no mesmo
//! lugar. `CoInitializeEx(MTA)` é por thread — o `CaptureClient` faz na criação
//! e desfaz no Drop.

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};

use super::super::AudioFormat;

/// Ponto de saída (loopback) ou entrada (mic).
use super::Which;

/// COM inicializado nesta thread — desfaz no Drop, na MESMA thread.
struct ComGuard;
impl ComGuard {
    fn enter() -> Self {
        // MTA porque a thread de captura não bombeia mensagens de janela. Se
        // alguém já inicializou como STA nesta thread, o hr é RPC_E_CHANGED_MODE
        // e a gente NÃO chama CoUninitialize (não fomos nós que inicializamos).
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        ComGuard
    }
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("não deu pra falar com o serviço de áudio do Windows: {}", e))
    }
}

/// Nome amigável do endpoint (o mesmo texto que a UI e o dshow mostram).
fn friendly_name(dev: &IMMDevice) -> Result<String, String> {
    unsafe {
        let store = dev
            .OpenPropertyStore(STGM_READ)
            .map_err(|e| format!("property store: {}", e))?;
        let mut prop = store
            .GetValue(&PKEY_Device_FriendlyName)
            .map_err(|e| format!("friendly name: {}", e))?;
        // O PROPVARIANT de string vem como LPWSTR; a `windows` expõe via helper.
        let name = prop.to_string();
        let _ = PropVariantClear(&mut prop);
        Ok(name)
    }
}

/// Escolhe um endpoint por nome (exato ou por prefixo — o dshow trunca nomes
/// longos, ver `name_matches`), ou o padrão quando `wanted` é vazio/None.
fn pick_endpoint(
    en: &IMMDeviceEnumerator,
    flow: windows::Win32::Media::Audio::EDataFlow,
    wanted: Option<&str>,
    empty_msg: &str,
) -> Result<IMMDevice, String> {
    unsafe {
        match wanted.filter(|s| !s.is_empty()) {
            None => en
                .GetDefaultAudioEndpoint(flow, eConsole)
                .map_err(|_| empty_msg.to_string()),
            Some(name) => {
                let coll = en
                    .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                    .map_err(|e| format!("listar endpoints: {}", e))?;
                let n = coll.GetCount().map_err(|e| format!("contar endpoints: {}", e))?;
                let mut approx: Option<IMMDevice> = None;
                for i in 0..n {
                    let Ok(dev) = coll.Item(i) else { continue };
                    let Ok(fname) = friendly_name(&dev) else { continue };
                    if fname == name {
                        return Ok(dev);
                    }
                    if approx.is_none() && super::name_matches(name, &fname) {
                        approx = Some(dev);
                    }
                }
                approx.ok_or_else(|| format!("não achei \"{}\" no WASAPI", name))
            }
        }
    }
}

/// Lê o WAVEFORMATEX (possivelmente EXTENSIBLE) e diz taxa/canais + se é float.
///
/// O mix format do Windows é quase sempre float 32; mas "quase sempre" não é
/// contrato, então a gente checa o SubFormat de verdade e recusa o que não sabe
/// converter (em vez de despejar bytes errados no ffmpeg como se fossem float).
struct MixFormat {
    sample_rate: u32,
    channels: u16,
    bytes_per_frame: usize,
    is_float: bool,
    bits: u16,
}

unsafe fn read_format(p: *const WAVEFORMATEX) -> Result<MixFormat, String> {
    // WAVEFORMATEX é packed: ler campo por referência é UB. Copia por valor
    // (read_unaligned) antes de tocar em qualquer coisa.
    let f = std::ptr::read_unaligned(p);
    let tag = f.wFormatTag;
    let bits = f.wBitsPerSample;
    let is_float = if tag as u32 == WAVE_FORMAT_IEEE_FLOAT {
        true
    } else if tag == WAVE_FORMAT_EXTENSIBLE as u16 {
        // WAVEFORMATEXTENSIBLE também é packed — o GUID SubFormat exige
        // alinhamento, então lê por ponteiro cru (nem via cópia local dá pra
        // pegar por referência sem UB).
        let sub = std::ptr::read_unaligned(std::ptr::addr_of!(
            (*(p as *const WAVEFORMATEXTENSIBLE)).SubFormat
        ));
        sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    } else {
        false
    };
    // Só float32 e int16 são tratados (é o que o mix format entrega na prática).
    if !((is_float && bits == 32) || (!is_float && bits == 16)) {
        return Err(format!(
            "formato de áudio não suportado (float={}, {} bits) — o loopback esperava float 32 ou int 16",
            is_float, bits
        ));
    }
    Ok(MixFormat {
        sample_rate: f.nSamplesPerSec,
        channels: f.nChannels,
        bytes_per_frame: f.nBlockAlign as usize,
        is_float,
        bits,
    })
}

/// Só o nome + formato de uma saída, pra sonda (sem `Initialize`).
pub fn describe_render(wanted: Option<&str>) -> Result<(String, AudioFormat), String> {
    let _com = ComGuard::enter();
    let en = enumerator()?;
    let dev = pick_endpoint(
        &en,
        eRender,
        wanted,
        "não há dispositivo de saída neste computador — sem ele não existe áudio do sistema pra capturar",
    )?;
    let name = friendly_name(&dev).unwrap_or_else(|_| "saída de áudio".to_string());
    unsafe {
        let client: IAudioClient = dev
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("ativar o cliente de áudio: {}", e))?;
        let p = client.GetMixFormat().map_err(|e| format!("mix format: {}", e))?;
        let mf = read_format(p);
        CoTaskMemFree(Some(p as *const _));
        let mf = mf?;
        Ok((name, AudioFormat { sample_rate: mf.sample_rate, channels: mf.channels }))
    }
}

/// Nomes das saídas ATIVAS, a padrão em primeiro.
pub fn list_render_names() -> Result<Vec<String>, String> {
    let _com = ComGuard::enter();
    let en = enumerator()?;
    unsafe {
        let default = en
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .ok()
            .and_then(|d| friendly_name(&d).ok());
        let coll = en
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("listar saídas: {}", e))?;
        let n = coll.GetCount().map_err(|e| format!("contar saídas: {}", e))?;
        let mut out = Vec::new();
        for i in 0..n {
            if let Ok(dev) = coll.Item(i) {
                if let Ok(name) = friendly_name(&dev) {
                    out.push(name);
                }
            }
        }
        if let Some(def) = default {
            if let Some(i) = out.iter().position(|x| *x == def) {
                out.swap(0, i);
            }
        }
        Ok(out)
    }
}

/// Cliente de captura vivo: dono do COM e do `IAudioClient`. Só se usa na thread
/// que o criou.
pub struct CaptureClient {
    _com: ComGuard,
    client: IAudioClient,
    capture: IAudioCaptureClient,
    fmt: MixFormat,
    name: String,
    // Buffer reaproveitado por bloco: converter pra f32 sem alocar a cada volta.
    scratch: Vec<f32>,
    started: bool,
}

// Só a thread de captura toca nele (nasce e morre lá); o `Send` é pra ele poder
// ser criado dentro do `spawn` e devolvido pelo canal — nunca é COMPARTILHADO.
unsafe impl Send for CaptureClient {}

/// Abre a captura: loopback numa saída, ou o mic direto.
///
/// LOOPBACK = ativar o cliente do endpoint de RENDER e inicializar com o flag
/// `AUDCLNT_STREAMFLAGS_LOOPBACK` (sem EVENTCALLBACK: polling). O mix format da
/// saída é o formato capturado — não se escolhe, entrega-se ao ffmpeg.
pub fn open_capture(which: &Which) -> Result<CaptureClient, String> {
    let com = ComGuard::enter();
    let en = enumerator()?;
    let (dev, loopback) = match which {
        Which::Output(id) => (
            pick_endpoint(
                &en,
                eRender,
                id.as_deref(),
                "não há dispositivo de saída neste computador — sem ele não existe áudio do sistema pra capturar",
            )?,
            true,
        ),
        Which::Input(id) => (
            pick_endpoint(&en, eCapture, id.as_deref(), "não há microfone neste computador")?,
            false,
        ),
    };
    let name = friendly_name(&dev).unwrap_or_else(|_| "dispositivo de áudio".to_string());

    unsafe {
        let client: IAudioClient = dev
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("ativar o cliente de áudio: {}", e))?;
        let p = client.GetMixFormat().map_err(|e| format!("mix format: {}", e))?;
        let fmt = read_format(p);
        let flags = if loopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
        // hnsBufferDuration=0: o Windows escolhe o buffer do modo compartilhado.
        // device_period=0: idem. É a receita canônica de loopback em shared.
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, p, None);
        CoTaskMemFree(Some(p as *const _));
        init.map_err(|e| {
            // Erro CLARO e na hora (não travamento): quem chama degrada com
            // honestidade. 0x800706CC costuma ser endpoint que não hospeda
            // stream — é ambiente, não este código.
            format!("o dispositivo de áudio recusou abrir ({}) — gravando sem o áudio do sistema", e)
        })?;

        let fmt = fmt?;
        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| format!("obter o cliente de captura: {}", e))?;
        client.Start().map_err(|e| format!("iniciar a captura: {}", e))?;

        Ok(CaptureClient {
            _com: com,
            client,
            capture,
            fmt,
            name,
            scratch: Vec::new(),
            started: true,
        })
    }
}

impl CaptureClient {
    pub fn format(&self) -> AudioFormat {
        AudioFormat { sample_rate: self.fmt.sample_rate, channels: self.fmt.channels }
    }
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Um bloco pronto, já em f32 (-1..1) entrelaçado. `Ok(None)` = nada pronto
    /// agora (o chamador espera 10ms e tenta de novo). O `bool` = silêncio.
    pub fn next_block(&mut self) -> Result<Option<(&[f32], bool)>, String> {
        unsafe {
            let packet = self
                .capture
                .GetNextPacketSize()
                .map_err(|e| format!("tamanho do pacote: {}", e))?;
            if packet == 0 {
                return Ok(None);
            }
            let mut pdata: *mut u8 = std::ptr::null_mut();
            let mut nframes: u32 = 0;
            let mut flags: u32 = 0;
            self.capture
                .GetBuffer(&mut pdata, &mut nframes, &mut flags, None, None)
                .map_err(|e| format!("ler o buffer: {}", e))?;

            let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            let ch = self.fmt.channels as usize;
            let n = nframes as usize * ch;
            self.scratch.clear();
            self.scratch.reserve(n);

            if silent || pdata.is_null() {
                // Bloco de silêncio: o ponteiro pode ser lixo — NÃO se lê dele.
                self.scratch.resize(n, 0.0);
            } else {
                let bytes = std::slice::from_raw_parts(pdata, nframes as usize * self.fmt.bytes_per_frame);
                if self.fmt.is_float {
                    // float32 nativo: reinterpreta 4 bytes por amostra.
                    for c in bytes.chunks_exact(4) {
                        self.scratch.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                    }
                } else {
                    // int16 → f32 (o caso raro de mix format não-float).
                    debug_assert_eq!(self.fmt.bits, 16);
                    for c in bytes.chunks_exact(2) {
                        self.scratch.push(i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0);
                    }
                }
            }
            // Devolve o buffer pro WASAPI SEMPRE (senão o anel entope e trava a
            // captura). O erro aqui é raro, mas é reportado.
            self.capture
                .ReleaseBuffer(nframes)
                .map_err(|e| format!("devolver o buffer: {}", e))?;
            Ok(Some((&self.scratch, silent)))
        }
    }
}

impl Drop for CaptureClient {
    fn drop(&mut self) {
        if self.started {
            unsafe {
                let _ = self.client.Stop();
            }
        }
        // `client`/`capture` (COM) são soltos aqui, e o `_com` (ComGuard) depois
        // — nesta ordem, nesta thread. É por isso que o cliente NÃO é Sync.
    }
}
