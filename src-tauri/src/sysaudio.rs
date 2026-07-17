//! Áudio do sistema (WASAPI loopback) + medidores de nível — onda 4.
//!
//! **A decisão do plano (§3.3):** o áudio do sistema é capturado NO RUST, não
//! pelo `dshow` do ffmpeg. O `dshow` só enxerga "Mixagem estéreo", que a metade
//! das placas não tem, vem desligada por padrão e some quando o driver muda —
//! ou seja, um caminho que às vezes existe. O WASAPI loopback é a API que o
//! Windows dá pra isso e não depende de o fabricante ter sido bonzinho.
//!
//! **A escolha da biblioteca — decidida na obra, com prova.** O plano mandava
//! avaliar `cpal` (dep já conhecida da suíte) e o crate `wasapi`, e escolher.
//! Comecei no `cpal` pelo reuso; a obra reprovou. O `cpal` 0.15 só faz loopback
//! por EVENTO (`EVENTCALLBACK | LOOPBACK`) e, numa máquina desta suíte (Realtek),
//! o `IAudioClient::Initialize` desse jeito **TRAVOU** — nem sucesso nem erro. O
//! crate `wasapi` usa os mesmos flags e falhou igual. Um `Initialize` que trava
//! congelaria a gravação. A escolha final é **WASAPI direto (crate `windows`) em
//! modo POLLING** (só `..._LOOPBACK`, sem evento; lê com `GetNextPacketSize`/
//! `GetBuffer`): é o modelo do OBS e **devolve erro na hora** em vez de travar —
//! degrada com honestidade. Custa o COM à mão (ver `win/wasapi.rs`), e vale.
//! Detalhe da máquina de teste: nela ATÉ um `Initialize` de render comum devolve
//! `0x800706CC` (o endpoint não hospeda stream nenhum) — é ambiente, não código;
//! por isso a captura de verdade não pôde ser exercitada AQUI, mas todo o resto
//! (pipe + pacer + ffmpeg + stop) foi provado com fonte sintética (ver relatório).
//!
//! **Como o PCM entra no ffmpeg — e por que NÃO pelo stdin.** O `record.rs` usa
//! o stdin do ffmpeg pra mandar o `q` do stop gracioso (é o que faz o contêiner
//! fechar com trailer, em vez de virar arquivo sem índice). Se o PCM ocupasse o
//! stdin, o `q` não teria por onde entrar e TODO take terminaria em `kill()`.
//! Então o áudio vai por um **named pipe** próprio (`\\.\pipe\localrecord-…`),
//! que o ffmpeg abre como mais uma entrada (`-f s16le -i \\.\pipe\…`). Dois
//! canais, dois donos: stdin = controle, pipe = dados.
//!
//! **Silêncio pago no relógio.** O loopback do WASAPI não entrega NADA quando
//! ninguém está tocando som (não é bug: não há quadro pra copiar). Se a gente
//! só repassasse o que chega, o ffmpeg passaria fome nos trechos mudos e o áudio
//! DERRAPARIA em relação ao vídeo — o pesadelo clássico de recording. Por isso o
//! escritor é PACEADO pelo relógio: a cada volta ele escreve exatamente o tanto
//! de amostras que o tempo real pede, completando com zeros o que a placa não
//! deu. Silêncio de verdade, na hora certa.
//!
//! **Linux:** pendente. O plano prevê o monitor do PulseAudio/pipewire e o
//! caminho não está feito nem testado — as funções daqui dizem isso na cara em
//! vez de gravar mudo fingindo que capturaram.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Contrato com o front (puro — existe nos dois SOs)
// ---------------------------------------------------------------------------

/// Formato do áudio do sistema. Não é escolha nossa: é o *mix format* do
/// dispositivo de saída. A gente ENTREGA esse formato pro ffmpeg em vez de
/// reamostrar aqui — o ffmpeg já sabe fazer isso melhor do que um resampler
/// escrito na mão, e menos conversão = menos lugar pra errar.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

/// O que o front precisa saber pra montar os args (regra da casa: os argumentos
/// do ffmpeg nascem no TS; o Rust só resolve binário e move bytes).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SysAudioInfo {
    pub id: String,
    pub label: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// O caminho do named pipe que o ffmpeg vai abrir como entrada.
    pub pipe_path: String,
}

/// Nível de uma fonte de áudio, do jeito que a UI desenha o VU.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
    /// "mic" ou "system" — a UI tem dois medidores.
    pub target: String,
    /// Pico do bloco, 0..1 (linear). Quem vira dB é o front.
    pub peak: f32,
}

/// Pra onde vai o nível medido. É um FECHAMENTO, e não o `AppHandle`, porque a
/// captura não pode depender de existir janela: o `examples/smoke_sysaudio.rs`
/// grava sem UI nenhuma. (E há um motivo mecânico além do estético: arrastar o
/// `tauri::Emitter` pra dentro de um binário de exemplo puxa junto a janela do
/// Windows, que um exe sem manifesto nem consegue carregar — o motor viraria
/// exercitável só através da UI, ou seja, não-provável.)
pub type LevelSink = std::sync::Arc<dyn Fn(AudioLevel) + Send + Sync>;

/// O sink de produção: joga o nível na ponte de eventos do Tauri.
///
/// NÃO é `#[cfg(windows)]`: é chamado por `sys_audio_start`/`restart_feed`, que
/// são código COMPARTILHADO (compilam nas duas plataformas). No Linux o
/// `SysAudioFeed::start` é o stub que devolve PENDENTE, mas o `emit_sink` ainda
/// precisa existir pra compilar a chamada. Gateá-lo quebrava o build do AppImage
/// (E0425: cannot find function `emit_sink`) — e só o CI do Linux pegava.
fn emit_sink(app: &tauri::AppHandle) -> LevelSink {
    use tauri::Emitter;
    let app = app.clone();
    std::sync::Arc::new(move |lvl: AudioLevel| {
        let _ = app.emit("audio-level", lvl);
    })
}

/// Nome do canal de áudio. Determinístico por processo: só existe UMA gravação
/// por vez (o `rec_start` recusa a segunda), então o pid basta pra dois
/// LocalRecord abertos não brigarem pelo mesmo nome.
pub fn sys_pipe_path() -> String {
    pipe_path_for(std::process::id())
}

pub fn pipe_path_for(pid: u32) -> String {
    format!(r"\\.\pipe\localrecord-sysaudio-{}", pid)
}

// ---------------------------------------------------------------------------
// Regras puras do escritor paceado (testadas sem placa de som nenhuma)
// ---------------------------------------------------------------------------

/// Quantas amostras (já contando os canais) o relógio pede até agora.
///
/// É u128 no meio porque `ms * rate * canais` estoura u64 em gravação longa —
/// e gravação longa é justamente o caso que este app existe pra atender.
pub fn samples_due(elapsed_ms: u64, rate: u32, channels: u16) -> u64 {
    let n = (elapsed_ms as u128) * (rate as u128) * (channels as u128) / 1000;
    n.min(u64::MAX as u128) as u64
}

/// O plano de uma volta do escritor: quanto tirar da fila, quanto completar de
/// silêncio e quanto jogar fora por atraso.
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Chunk {
    /// Amostras reais tiradas da fila.
    pub take: usize,
    /// Zeros escritos porque a placa não deu áudio (ninguém tocando som).
    pub pad: usize,
    /// Amostras VELHAS descartadas: a fila passou do teto e insistir nelas só
    /// aumentaria o atraso do áudio pra sempre.
    pub drop_old: usize,
}

pub fn plan_chunk(due: u64, written: u64, queued: usize, max_backlog: usize) -> Chunk {
    let need = due.saturating_sub(written).min(usize::MAX as u64) as usize;
    // O que sobra ALÉM do que vai ser consumido agora + a folga tolerada é
    // atraso puro. Descarta o mais velho: quem chega atrasado no áudio ao vivo
    // não vira "mais tarde", vira derrapagem.
    let drop_old = queued.saturating_sub(need.saturating_add(max_backlog));
    let avail = queued - drop_old;
    let take = need.min(avail);
    Chunk { take, pad: need - take, drop_old }
}

/// f32 (-1..1) → i16. O clamp existe porque o mix do Windows PODE passar de 1.0
/// (soma de apps em float); sem ele, o `as i16` daria a volta e um pico viraria
/// estalo invertido no take.
pub fn to_i16(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0) as i16
}

/// O id do mic vem da lista do **dshow** (é o que o ffmpeg quer nos args) e o
/// medidor precisa achar o MESMO aparelho no **WASAPI** (que é o que o cpal
/// enxerga). Os dois nomes saem do mesmo "friendly name" do Windows, mas o
/// dshow trunca nomes longos — daí o casamento por prefixo.
///
/// Sem casar, NÃO há medidor: mostrar o nível de outro microfone seria mentira
/// pior que não mostrar nada.
pub fn name_matches(wanted: &str, candidate: &str) -> bool {
    if wanted == candidate {
        return true;
    }
    let (short, long) = if wanted.len() <= candidate.len() {
        (wanted, candidate)
    } else {
        (candidate, wanted)
    };
    // 8 caracteres: menos que isso, "Mic" casaria com qualquer coisa.
    short.len() >= 8 && long.starts_with(short)
}

// ---------------------------------------------------------------------------
// Windows: captura de verdade
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::{list_outputs, SysAudioFeed};

#[cfg(windows)]
pub type MonitorState = win::MonitorState;

// ---------------------------------------------------------------------------
// Linux: pendente, e dito na cara
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
pub const PENDENTE: &str =
    "áudio do sistema: por enquanto só no Windows (WASAPI loopback). No Linux o caminho é o monitor do PulseAudio/pipewire e ainda não foi feito.";

#[cfg(not(windows))]
#[derive(Default)]
pub struct MonitorState;

#[cfg(not(windows))]
pub struct SysAudioFeed;

#[cfg(not(windows))]
impl SysAudioFeed {
    pub fn start(
        _sink: Option<LevelSink>,
        _device_id: Option<String>,
    ) -> Result<(Self, SysAudioInfo), String> {
        Err(PENDENTE.to_string())
    }
    pub fn stop(&self) {}
    pub fn error(&self) -> Option<String> {
        None
    }
}

#[cfg(not(windows))]
pub fn list_outputs() -> Vec<crate::devices::Device> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// Estado: o feed vivo (um por vez, como a gravação)
// ---------------------------------------------------------------------------

struct Live {
    feed: SysAudioFeed,
    /// Guardado pra refazer o canal na 2ª tentativa da gravação (ver `restart`).
    device_id: Option<String>,
}

#[derive(Default)]
pub struct SysAudioState {
    inner: std::sync::Mutex<Option<Live>>,
}

/// Liga a captura e devolve o formato REAL + o caminho do canal.
///
/// **Por que isto é um comando separado, chamado ANTES do `rec_start`:** o front
/// precisa do formato (`-ar`/`-ac`) e do caminho do pipe pra montar os args — e
/// esses números têm que sair do dispositivo de verdade, não de uma sonda feita
/// antes que pode ter envelhecido (o usuário troca o fone e a taxa muda). Aqui o
/// que a gente informa é o que a gente está capturando, no mesmo instante.
///
/// Falhou (não há saída de áudio, o driver recusou)? Isto devolve **erro com o
/// motivo** e a UI grava sem o áudio do sistema, dizendo por quê. O que este app
/// não faz é gravar silêncio fingindo que capturou.
#[tauri::command(async)]
pub fn sys_audio_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SysAudioState>,
    device_id: Option<String>,
) -> Result<SysAudioInfo, String> {
    stop_feed(&state);
    let (feed, info) = SysAudioFeed::start(Some(emit_sink(&app)), device_id.clone())?;
    if let Ok(mut g) = state.inner.lock() {
        *g = Some(Live { feed, device_id });
    }
    Ok(info)
}

#[tauri::command(async)]
pub fn sys_audio_stop(state: tauri::State<'_, SysAudioState>) {
    stop_feed(&state);
}

pub fn stop_feed(state: &SysAudioState) {
    if let Ok(mut g) = state.inner.lock() {
        if let Some(l) = g.take() {
            l.feed.stop();
        }
    }
}

/// Sinaliza o feed a parar SEM removê-lo do estado ainda.
///
/// Chamado ANTES do `q` do stop gracioso: quando o ffmpeg fecha o cano no
/// shutdown, o escritor toma um "cano quebrado" — que é ESPERADO, não um erro
/// de verdade. Com o flag de stop já erguido, o pacer trata essa quebra como
/// fim normal e não a registra. Sem isto, todo stop bem-sucedido acenderia um
/// falso "o áudio do sistema caiu no meio".
pub fn signal_feed_stop(state: &SysAudioState) {
    if let Ok(g) = state.inner.lock() {
        if let Some(l) = g.as_ref() {
            l.feed.stop();
        }
    }
}

/// O que deu errado no meio do caminho (a placa reclamou, o canal caiu). O
/// `rec_stop` conta isso pro usuário: aquele trecho é silêncio DE VERDADE.
pub fn feed_error(state: &SysAudioState) -> Option<String> {
    state.inner.lock().ok().and_then(|g| g.as_ref().and_then(|l| l.feed.error()))
}

pub fn feed_running(state: &SysAudioState) -> bool {
    state.inner.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Refaz o canal pra 2ª tentativa da gravação (o fallback ddagrab→gdigrab).
///
/// Sem isto o plano B nasceria morto: o named pipe morre junto com o ffmpeg que
/// o abriu, e o segundo ffmpeg não teria o que abrir.
pub fn restart_feed(app: &tauri::AppHandle, state: &SysAudioState) -> Result<(), String> {
    let device_id = {
        let Ok(g) = state.inner.lock() else { return Err("estado corrompido".into()) };
        match g.as_ref() {
            Some(l) => l.device_id.clone(),
            None => return Ok(()), // não havia áudio do sistema: nada a refazer
        }
    };
    stop_feed(state);
    let (feed, _) = SysAudioFeed::start(Some(emit_sink(app)), device_id.clone())?;
    if let Ok(mut g) = state.inner.lock() {
        *g = Some(Live { feed, device_id });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

/// Sonda o dispositivo de saída sem capturar nada: existe? qual é o nome dele?
/// É o que decide se o botão de áudio do sistema fica ligável — e, quando não
/// fica, é daqui que sai o motivo mostrado na tela.
#[tauri::command(async)]
pub fn sys_audio_probe(device_id: Option<String>) -> Result<SysAudioInfo, String> {
    #[cfg(windows)]
    {
        win::probe(device_id)
    }
    #[cfg(not(windows))]
    {
        let _ = device_id;
        Err(PENDENTE.to_string())
    }
}

/// Liga o medidor de nível (VU) de uma fonte, ANTES de gravar: o usuário tem que
/// ver o áudio entrando, não descobrir no play que o take saiu mudo.
///
/// `target` = "mic" | "system". Emite `audio-level` até o `audio_monitor_stop`.
#[tauri::command(async)]
pub fn audio_monitor_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, MonitorState>,
    target: String,
    device_id: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::monitor_start(emit_sink(&app), &state, &target, device_id)
    }
    #[cfg(not(windows))]
    {
        let (_, _, _, _) = (&app, &state, &target, &device_id);
        Err(PENDENTE.to_string())
    }
}

/// `target` ausente = desliga todos os medidores (o que a gravação faz: medidor
/// não pode disputar o microfone com o ffmpeg).
#[tauri::command(async)]
pub fn audio_monitor_stop(state: tauri::State<'_, MonitorState>, target: Option<String>) {
    #[cfg(windows)]
    {
        win::monitor_stop(&state, target.as_deref());
    }
    #[cfg(not(windows))]
    {
        let (_, _) = (&state, &target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relogio_manda_no_quanto_escrever() {
        // 1s de 48k estéreo = 96000 amostras entrelaçadas.
        assert_eq!(samples_due(1000, 48_000, 2), 96_000);
        assert_eq!(samples_due(0, 48_000, 2), 0);
        assert_eq!(samples_due(20, 48_000, 2), 1_920);
        // Mono e 44,1k também são formato de mix válido (a placa é quem manda).
        assert_eq!(samples_due(1000, 44_100, 1), 44_100);
    }

    #[test]
    fn gravacao_longa_nao_estoura_a_conta() {
        // 24h de 48k 8 canais: em u64 puro (ms*rate*ch) isto passaria de 2^64
        // no meio da multiplicação. É o cálculo que roda a cada 10ms por horas.
        let day = 24 * 60 * 60 * 1000;
        assert_eq!(samples_due(day, 48_000, 8), 33_177_600_000);
    }

    #[test]
    fn ninguem_tocando_som_vira_silencio_no_lugar_certo() {
        // O CASO QUE MANDA: a fila está vazia porque o WASAPI não entrega nada
        // quando não há som tocando. Escrever zeros é o que segura a sincronia —
        // sem isto o ffmpeg passaria fome e o áudio derraparia do vídeo.
        let c = plan_chunk(1920, 0, 0, 96_000);
        assert_eq!(c, Chunk { take: 0, pad: 1920, drop_old: 0 });
    }

    #[test]
    fn com_som_tocando_o_pcm_real_passa_inteiro() {
        let c = plan_chunk(1920, 0, 5000, 96_000);
        assert_eq!(c, Chunk { take: 1920, pad: 0, drop_old: 0 });
        // Meio a meio: o que a placa deu vem primeiro, o resto é silêncio.
        let c = plan_chunk(1920, 0, 900, 96_000);
        assert_eq!(c, Chunk { take: 900, pad: 1020, drop_old: 0 });
    }

    #[test]
    fn ja_escrito_nao_se_escreve_de_novo() {
        // 2ª volta: o relógio pede 3840 no total e 1920 já foram.
        let c = plan_chunk(3840, 1920, 10_000, 96_000);
        assert_eq!(c.take, 1920);
        // Volta sem tempo decorrido: não escreve nada (não adianta o áudio).
        assert_eq!(plan_chunk(1920, 1920, 10_000, 96_000), Chunk { take: 0, pad: 0, drop_old: 0 });
        // Relógio "andou pra trás" não vira número negativo/pânico.
        assert_eq!(plan_chunk(100, 500, 10, 96_000), Chunk { take: 0, pad: 0, drop_old: 0 });
    }

    #[test]
    fn fila_estourada_joga_fora_o_velho_e_nao_a_sincronia() {
        // Teto de 1000 amostras de folga: com 5000 na fila e 100 pedidas agora,
        // 3900 são atraso puro. Guardar isso só empurraria o áudio pra frente
        // pra sempre (e comeria RAM numa gravação de 2h).
        let c = plan_chunk(100, 0, 5000, 1000);
        assert_eq!(c, Chunk { take: 100, pad: 0, drop_old: 3900 });
        // Dentro do teto, ninguém é descartado.
        let c = plan_chunk(100, 0, 900, 1000);
        assert_eq!(c, Chunk { take: 100, pad: 0, drop_old: 0 });
    }

    #[test]
    fn pico_estourado_nao_da_a_volta() {
        // O mix do Windows é float e PODE passar de 1.0; sem clamp, o `as i16`
        // daria a volta e o pico viraria estalo invertido.
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.0), 32767);
        assert_eq!(to_i16(-1.0), -32767);
        assert_eq!(to_i16(2.5), 32767);
        assert_eq!(to_i16(-2.5), -32767);
    }

    #[test]
    fn medidor_do_mic_casa_o_nome_do_dshow_com_o_do_wasapi() {
        // O dshow trunca o nome; o WASAPI entrega inteiro. É o mesmo aparelho.
        assert!(name_matches(
            "Microfone (Realtek(R) Audio)",
            "Microfone (Realtek(R) Audio)"
        ));
        assert!(name_matches("Microfone (Realtek(R) A", "Microfone (Realtek(R) Audio)"));
        // Aparelhos diferentes NÃO casam — medidor errado é mentira.
        assert!(!name_matches("Microfone (Realtek(R) Audio)", "Microfone (HD Webcam C270)"));
        // Nome curto demais não casa por prefixo (senão "Mic" pegaria qualquer um).
        assert!(!name_matches("Mic", "Microfone (Realtek(R) Audio)"));
        assert!(!name_matches("", "Qualquer coisa"));
    }

    #[test]
    fn o_canal_de_audio_e_por_processo() {
        // Dois LocalRecord abertos não podem disputar o mesmo pipe.
        assert_eq!(pipe_path_for(1234), r"\\.\pipe\localrecord-sysaudio-1234");
        assert_ne!(pipe_path_for(1), pipe_path_for(2));
        assert!(sys_pipe_path().starts_with(r"\\.\pipe\localrecord-sysaudio-"));
    }
}
