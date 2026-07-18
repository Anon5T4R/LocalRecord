import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AudioMeter from "./components/AudioMeter";
import Preview from "./components/Preview";
import SettingsModal from "./components/SettingsModal";
import Toasts from "./components/Toasts";
import {
  buildRecordArgs,
  buildRemuxArgs,
  expandPattern,
  pickCamMode,
  type AudioTracks,
  type CamMode,
  type Corner,
  type Encoder,
  type Grabber,
  type Platform,
  type RecordSpec,
  type SysAudioSpec,
} from "./lib/args";
import { t, type MessageKey } from "./lib/i18n";
import {
  formatBytes,
  formatDuration,
  pickDefault,
  PRIMARY_SCREEN,
  type Device,
  type DeviceList,
  type SysAudioInfo,
} from "./lib/sources";
import {
  labelsFor,
  FPS_OPTIONS,
  loadSetup,
  reconcileSetup,
  saveSetup,
  type TargetFps,
  type DroppedKind,
} from "./lib/setup";
import { useUi } from "./state/ui";

// Fora do Tauri (smoke no navegador com `npm run preview`) não há back: a UI
// renderiza vazia em vez de estourar no invoke.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const EMPTY: DeviceList = { screens: [], cameras: [], microphones: [], outputs: [] };

/** Fases da gravação. `stopping` existe porque fechar o contêiner leva um
 *  tempo real (o ffmpeg escreve o trailer) e o botão não pode piscar "Gravar"
 *  antes do arquivo estar fechado. */
type Phase = "idle" | "countdown" | "recording" | "stopping";

interface RecProgress {
  elapsedMs: number;
  fps: string;
  sizeBytes: number;
  speed: string;
}

interface RecordDone {
  path: string;
  graceful: boolean;
  remuxed: boolean;
  /** O áudio do sistema caiu no meio? Vem o motivo (ver record.rs). */
  sysAudioError: string | null;
  /** A captura de TELA morreu no meio: o áudio continua bom e o vídeo congela. */
  captureLost: boolean;
  /** Log do ffmpeg, preservado quando algo deu errado. `null` = take limpo. */
  logPath: string | null;
  /** O arquivo final foi CONFERIDO com ffprobe e tem menos vídeo do que devia. */
  takeDegraded: boolean;
  /** Pacotes de vídeo reais e esperados — pra dizer o tamanho do estrago. */
  frames: number | null;
  framesExpected: number | null;
}

/** Nível de uma fonte, emitido pelo Rust (cpal) enquanto o medidor está ligado. */
interface AudioLevelEvent {
  target: "mic" | "system";
  peak: number;
}

interface AnnotSnapshot {
  armed: boolean;
  pen: boolean;
}

/** Os mesmos atalhos de `annot.rs` — aqui só pra MOSTRAR ao usuário. Quem
 *  registra de verdade é o Rust; isto é rótulo, não configuração. */
const SC_PEN = "Ctrl+Shift+D";
const SC_CLEAR = "Ctrl+Shift+X";

/** Qual aviso mostrar quando um device salvo sumiu, por tipo. */
const DROP_KEY: Record<DroppedKind, MessageKey> = {
  camera: "setup.cameraGone",
  mic: "setup.micGone",
  output: "setup.outputGone",
};

const platform: Platform =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows") ? "windows" : "linux";

/** A tela é capturada pela DDA no Windows (GPU) e pelo x11grab no Linux.
 *  O gdigrab não entra aqui: ele é só o plano B, montado no `rec_start`. */
const GRABBER: Grabber = platform === "windows" ? "ddagrab" : "x11grab";

const ZERO: RecProgress = { elapsedMs: 0, fps: "", sizeBytes: 0, speed: "" };

/** <select> de uma fonte. `emptyLabel` = a opção "nenhum" (câmera/mic são opcionais). */
function SourceSelect(props: {
  label: string;
  devices: Device[];
  value: string;
  onChange: (v: string) => void;
  emptyLabel?: string;
  labelFor?: (d: Device) => string;
  disabled?: boolean;
}) {
  const { label, devices, value, onChange, emptyLabel, labelFor, disabled } = props;
  return (
    <div className="source-row">
      <span className="muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || devices.length === 0}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {labelFor ? labelFor(d) : d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function App() {
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const pushToast = useUi((s) => s.pushToast);

  // Setup salvo da sessão anterior (as "boxes marcadas"). Lido UMA vez. Os
  // campos de LAYOUT já saem restaurados aqui (não dependem de device existir);
  // os DEVICES começam vazios e só entram depois de reconciliados contra a
  // lista real no boot (ver o efeito de restauração) — restaurar um id de
  // device que sumiu seria pior que não restaurar.
  const saved0 = useMemo(() => loadSetup(), []);
  const initial = useMemo(() => reconcileSetup(saved0, EMPTY).setup, [saved0]);
  // Vira `true` só quando a reconciliação do boot terminou. Antes disso o efeito
  // que persiste fica quieto: salvar os defaults iniciais aqui apagaria o setup
  // salvo antes mesmo de restaurá-lo.
  const restored = useRef(false);

  const [devices, setDevices] = useState<DeviceList>(EMPTY);
  const [loading, setLoading] = useState(isTauri);
  const [ffOk, setFfOk] = useState(true); // otimista: só avisa depois de confirmar
  const [screen, setScreen] = useState(initial.screen);
  const [camera, setCamera] = useState(initial.camera);
  // Modos que a câmera escolhida oferece de verdade. Vazio = não deu pra
  // enumerar (Linux, ou o dispositivo não respondeu) e aí o ffmpeg decide.
  const [camModes, setCamModes] = useState<CamMode[]>([]);
  const [mic, setMic] = useState(initial.mic);

  // Áudio do sistema (WASAPI loopback, capturado no Rust — ver sysaudio.rs).
  const [output, setOutput] = useState(initial.output);
  const [sysOn, setSysOn] = useState(initial.sysOn);
  /** Por que NÃO dá pra capturar aqui (sem placa de saída, Linux, driver
   *  recusando). Preenchido = o controle fica desligado e a tela diz o motivo. */
  const [sysErr, setSysErr] = useState<string | null>(null);
  const [tracks, setTracks] = useState<AudioTracks>(initial.tracks);
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  const [micMeterErr, setMicMeterErr] = useState<string | null>(null);
  const [sysMeterErr, setSysMeterErr] = useState<string | null>(null);

  const [corner, setCorner] = useState<Corner>(initial.corner);
  const [sizePct, setSizePct] = useState(initial.sizePct);
  // O alvo de quadros por segundo. Deixou de ser constante na v0.5.1: 60 pra
  // quem tem folga, 24 pra quem tem câmera fraca — e é PRA BAIXO que a escolha
  // ajuda nesse caso, não pra cima.
  const [fps, setFps] = useState<TargetFps>(initial.fps);
  const [outDir, setOutDir] = useState("");
  const [pattern, setPattern] = useState("gravacao-{date}-{time}");
  const [encoder, setEncoder] = useState<Encoder | "">("");

  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState(3);
  const [progress, setProgress] = useState<RecProgress>(ZERO);
  const [annot, setAnnot] = useState<AnnotSnapshot>({ armed: false, pen: false });

  const busy = phase !== "idle";
  // O botão some do caminho durante a contagem: cancelar no meio dela é onda 3.
  const canRecord = isTauri && ffOk && !!screen && phase === "idle";

  const load = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    try {
      const list = await invoke<DeviceList>("list_devices");
      setDevices(list);
      // Reaproveita a escolha anterior quando o dispositivo sobreviveu ao
      // replug; tela sempre tem seleção, câmera/mic podem ficar em "nenhum".
      setScreen((prev) => pickDefault(list.screens, prev, PRIMARY_SCREEN));
      setCamera((prev) => pickDefault(list.cameras, prev));
      setMic((prev) => pickDefault(list.microphones, prev));
      // A saída PADRÃO vem em primeiro na lista (contrato do sysaudio) — é o
      // que o usuário quer em quase todo caso, então é o default aqui.
      setOutput((prev) => pickDefault(list.outputs, prev, list.outputs[0]?.id ?? ""));
    } catch (e) {
      pushToast("error", t("sources.loadFailed", { error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  // Restauração do boot: PRIMEIRA carga dos dispositivos, reconciliando o setup
  // salvo contra a lista real. É aqui que um device que sumiu (webcam
  // desplugada) cai no default e o usuário é avisado — em vez de o ffmpeg
  // engasgar na hora de gravar com um id fantasma. Separado do `load` (o botão
  // "Procurar de novo") de propósito: replug no meio da sessão é silencioso;
  // restaurar de uma sessão antiga é que merece o aviso.
  const bootRestore = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    try {
      const list = await invoke<DeviceList>("list_devices");
      setDevices(list);
      const { setup, dropped } = reconcileSetup(saved0, list);
      setScreen(setup.screen);
      setCamera(setup.camera);
      setMic(setup.mic);
      setOutput(setup.output);
      setSysOn(setup.sysOn);
      setTracks(setup.tracks);
      setCorner(setup.corner);
      setSizePct(setup.sizePct);
      for (const d of dropped) {
        pushToast("info", t(DROP_KEY[d.kind], { device: d.label }));
      }
    } catch (e) {
      pushToast("error", t("sources.loadFailed", { error: String(e) }));
    } finally {
      // Só a partir daqui o efeito de persistência pode gravar: antes disso o
      // que está na tela ainda são os defaults, não a escolha do usuário.
      restored.current = true;
      setLoading(false);
    }
  }, [pushToast, saved0]);

  useEffect(() => {
    if (!isTauri) return;
    invoke<boolean>("ffmpeg_ok").then(setFfOk).catch(() => setFfOk(false));
    void bootRestore();
    invoke<string>("rec_default_dir").then(setOutDir).catch(() => setOutDir(""));
    // Sonda de verdade (codifica 0,1s) — pode demorar; a UI mostra "testando…".
    invoke<Encoder>("rec_pick_encoder").then(setEncoder).catch(() => setEncoder("libx264"));
    // Reconciliação: a webview pode ter recarregado com o ffmpeg ainda gravando.
    invoke<boolean>("rec_status")
      .then((on) => on && setPhase("recording"))
      .catch(() => {});
    // Mesma reconciliação pro overlay: ele é uma JANELA que sobrevive ao reload
    // desta webview — o botão tem que refletir o que está de pé na tela, não o
    // que o React acha que está.
    invoke<AnnotSnapshot>("annot_state").then(setAnnot).catch(() => {});
  }, [bootRestore]);

  // Persistência do setup: salva a cada mudança de escolha, mas só depois que a
  // restauração do boot terminou (ver `restored`). Guardar aqui, e não no
  // unmount, é o robusto: fechar a janela do Tauri nem sempre passa por um
  // unmount limpo, e queremos o setup salvo mesmo se o app for morto.
  useEffect(() => {
    if (!isTauri || !restored.current) return;
    saveSetup({
      screen,
      camera,
      mic,
      output,
      sysOn,
      tracks,
      corner,
      sizePct,
      fps,
      // Guarda o rótulo dos escolhidos AGORA: se um deles sumir na próxima
      // sessão, é só assim que o aviso consegue dizer o nome (o device já não
      // estará na lista pra consultar).
      labels: labelsFor(devices, [screen, camera, mic, output]),
    });
  }, [screen, camera, mic, output, sysOn, tracks, corner, sizePct, fps, devices]);

  // A sonda decide se o áudio do sistema é OFERECÍVEL nesta máquina. Ela não
  // captura nada — só pergunta ao Windows se existe saída de áudio e qual é.
  // Sem isso o checkbox seria uma promessa: o usuário marcaria, gravaria 40min
  // e descobriria no play que não tinha o que capturar.
  useEffect(() => {
    if (!isTauri) return;
    invoke<SysAudioInfo>("sys_audio_probe", { deviceId: output || null })
      .then(() => setSysErr(null))
      .catch((e) => {
        setSysErr(String(e));
        setSysOn(false);
      });
  }, [output]);

  // Os modos da câmera escolhida. Perguntar ao DISPOSITIVO em vez de deixar o
  // dshow escolher foi o conserto do bug de 2026-07-18: ele escolhia 1080p cru,
  // que a webcam só entrega a 5 fps, e a gravação inteira ia junto.
  useEffect(() => {
    if (!isTauri || !camera) {
      setCamModes([]);
      return;
    }
    let alive = true;
    invoke<CamMode[]>("camera_modes", { id: camera })
      .then((m) => alive && setCamModes(m))
      // Falhar aqui não impede gravar: sem modos, volta ao comportamento antigo.
      .catch(() => alive && setCamModes([]));
    return () => {
      alive = false;
    };
  }, [camera]);

  // Progresso vem do próprio ffmpeg (`-progress pipe:1`), não de um cronômetro
  // nosso: o número na tela é o tempo que foi REALMENTE parar no arquivo.
  useEffect(() => {
    if (!isTauri) return;
    const un = [
      listen<RecProgress>("rec-progress", (e) => setProgress(e.payload)),
      listen<AudioLevelEvent>("audio-level", (e) =>
        setLevels((l) => ({ ...l, [e.payload.target]: e.payload.peak })),
      ),
      listen<string>("rec-notice", (e) => pushToast("info", t("rec.fallback", { error: e.payload }))),
      // Os dois avisos AO VIVO. A v0.3 só descobria o estrago no stop — o
      // usuário gravava 2 minutos de nada e só então era informado. Aqui ele
      // fica sabendo enquanto ainda dá pra parar e refazer.
      listen("rec-capture-lost", () => pushToast("error", t("rec.captureLostLive"))),
      listen<string>("rec-fps-low", (e) => pushToast("error", t("rec.fpsLow", { fps: e.payload }))),
      // O atalho global liga a caneta sem passar por esta janela — sem ouvir
      // isto, o painel mentiria sobre o estado do overlay.
      listen<AnnotSnapshot>("annot-state", (e) => setAnnot(e.payload)),
    ];
    return () => {
      for (const p of un) void p.then((f) => f());
    };
  }, [pushToast]);

  // Medidor do MICROFONE. Só enquanto parado: durante a gravação quem tem o mic
  // é o ffmpeg (dshow), e ficar disputando o aparelho com ele seria pedir pra
  // perder o áudio do take — que é o oposto do que este medidor existe pra fazer.
  useEffect(() => {
    if (!isTauri) return;
    if (phase !== "idle" || !mic) {
      void invoke("audio_monitor_stop", { target: "mic" });
      setLevels((l) => ({ ...l, mic: 0 }));
      return;
    }
    invoke("audio_monitor_start", { target: "mic", deviceId: mic })
      .then(() => setMicMeterErr(null))
      .catch((e) => setMicMeterErr(String(e)));
  }, [mic, phase]);

  // Medidor do ÁUDIO DO SISTEMA. Enquanto grava, quem manda nível é o próprio
  // feed (o Rust já mede o que está mandando pro ffmpeg), então aqui o monitor
  // avulso sai de cena e a barra continua viva.
  useEffect(() => {
    if (!isTauri) return;
    if (phase !== "idle" || !sysOn || sysErr) {
      void invoke("audio_monitor_stop", { target: "system" });
      if (!sysOn) setLevels((l) => ({ ...l, system: 0 }));
      return;
    }
    invoke("audio_monitor_start", { target: "system", deviceId: output || null })
      .then(() => setSysMeterErr(null))
      .catch((e) => setSysMeterErr(String(e)));
  }, [output, sysOn, sysErr, phase]);

  // Fechar a janela não pode deixar captura de áudio viva atrás.
  useEffect(() => {
    if (!isTauri) return;
    return () => {
      void invoke("audio_monitor_stop", { target: null });
    };
  }, []);

  const doStart = useCallback(async () => {
    const stamp = expandPattern(pattern, new Date());
    const base = `${outDir}/${stamp}`;
    try {
      // Os dois caminhos passam pelo unique_path: o MP4 é o entregável, mas um
      // MKV órfão de um remux que falhou antes não pode ser sobrescrito — seria
      // trocar um take salvo por um take novo.
      const mkvPath = await invoke<string>("unique_path", { path: `${base}.mkv` });
      const mp4Path = await invoke<string>("unique_path", {
        path: mkvPath.replace(/\.mkv$/i, ".mp4"),
      });

      // O áudio do sistema tem que subir ANTES dos args: é o Rust que cria o
      // canal e sabe em que formato a placa mistura o som — esses números vão
      // crus pro `-f s16le -ar … -ac …`. Sondar antes e confiar depois daria a
      // chance de o usuário trocar o fone no meio e o áudio sair em câmera lenta.
      let sysAudio: SysAudioSpec | null = null;
      if (sysOn && !sysErr) {
        try {
          const info = await invoke<SysAudioInfo>("sys_audio_start", {
            deviceId: output || null,
          });
          sysAudio = {
            pipePath: info.pipePath,
            sampleRate: info.sampleRate,
            channels: info.channels,
          };
        } catch (e) {
          // DEGRADAR COM HONESTIDADE: a gravação acontece (a tela é o que o
          // usuário veio buscar), mas SEM o áudio do sistema e DIZENDO isso.
          // O pecado seria seguir com o checkbox marcado e entregar um take em
          // silêncio como se tudo tivesse dado certo.
          setSysErr(String(e));
          pushToast("info", t("rec.sysAudioOff", { error: String(e) }));
        }
      }

      const spec: RecordSpec = {
        platform,
        grabber: GRABBER,
        fps,
        camera: camera
          ? { id: camera, corner, sizePct, mode: pickCamMode(camModes, fps, sizePct) }
          : null,
        mic: mic || null,
        sysAudio,
        audioTracks: tracks,
        encoder: encoder || "libx264",
        outPath: mkvPath,
      };
      // O plano B só existe onde a DDA existe: no Linux não há gdigrab.
      const fallbackArgs =
        GRABBER === "ddagrab" ? buildRecordArgs({ ...spec, grabber: "gdigrab" }) : null;

      setProgress(ZERO);

      // O LocalRecord sai da tela ANTES do ffmpeg abrir o olho: `ddagrab`
      // captura o que está na tela, então a própria janela do gravador entraria
      // nos primeiros quadros do vídeo. Minimizar e não `hide()`: escondido de
      // verdade some da barra de tarefas, e o usuário ficaria sem NENHUM jeito
      // de voltar aqui pra apertar Parar.
      if (isTauri) await getCurrentWindow().minimize();

      await invoke("rec_start", {
        opts: {
          args: buildRecordArgs(spec),
          fallbackArgs,
          remuxArgs: buildRemuxArgs(mkvPath, mp4Path),
          mkvPath,
          mp4Path,
          // O alvo vai junto pro Rust poder comparar com o fps REAL e falar
          // durante a gravação — e pra conferir o arquivo no stop.
          targetFps: spec.fps,
        },
      });
      setPhase("recording");
    } catch (e) {
      // Deu errado: a janela VOLTA. Ficar minimizada depois de um erro deixaria
      // o usuário achando que o app sumiu.
      if (isTauri) await getCurrentWindow().unminimize().catch(() => {});
      // E o canal do áudio não pode sobreviver à gravação que não nasceu: ele
      // segura uma captura WASAPI e uma thread esperando um ffmpeg que não vem.
      if (isTauri) await invoke("sys_audio_stop").catch(() => {});
      setPhase("idle");
      pushToast("error", t("rec.failed", { error: String(e) }));
    }
  }, [camera, camModes, corner, encoder, fps, mic, outDir, output, pattern, pushToast, sizePct, sysErr, sysOn, tracks]);

  // Contagem regressiva: o usuário precisa de tempo pra sair do LocalRecord e
  // ir pra janela que ele vai demonstrar.
  const tick = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (phase !== "countdown") return;
    if (count <= 0) {
      void doStart();
      return;
    }
    tick.current = window.setTimeout(() => setCount((c) => c - 1), 1000);
    return () => window.clearTimeout(tick.current);
  }, [phase, count, doStart]);

  const start = () => {
    if (!screen) {
      pushToast("error", t("rec.needScreen"));
      return;
    }
    setCount(3);
    setPhase("countdown");
  };

  const arm = async (on: boolean) => {
    try {
      setAnnot(await invoke<AnnotSnapshot>("annot_arm", { on }));
    } catch (e) {
      pushToast("error", t("annot.failed", { error: String(e) }));
    }
  };

  const stop = async () => {
    setPhase("stopping");
    try {
      const done = await invoke<RecordDone>("rec_stop");
      // Ordem das mensagens: primeiro os avisos (contexto), depois onde o
      // arquivo ficou (a informação que o usuário foi buscar).
      if (!done.graceful) pushToast("info", t("rec.killed"));
      // O áudio do sistema caiu no meio: o usuário PRECISA saber agora, não na
      // hora de editar. Silêncio inexplicado é o pior jeito de descobrir.
      if (done.sysAudioError) {
        pushToast("info", t("rec.sysAudioLost", { error: done.sysAudioError }));
      }
      // A captura de tela morreu no meio. Isto vira ERRO, não aviso: o take
      // continua existindo e com áudio bom, mas o vídeo congelou — e descobrir
      // isso no play, depois de gravar, é a pior hora possível.
      if (done.captureLost) pushToast("error", t("rec.captureLost"));
      // O veredito do ffprobe sobre o arquivo que ficou. Vale por si: dá pra
      // sair degenerado sem NENHUM marcador no stderr (o ddagrab entregando
      // quadro repetido devagar não reclama), e aí este é o único que pega.
      if (done.takeDegraded) {
        pushToast(
          "error",
          t("rec.takeDegraded", {
            frames: String(done.frames ?? "?"),
            expected: String(done.framesExpected ?? "?"),
          }),
        );
      }
      pushToast(
        // Take quebrado não merece o verde de "deu tudo certo" — nem o que
        // perdeu a captura, nem o que o ffprobe reprovou.
        done.remuxed && !done.captureLost && !done.takeDegraded ? "ok" : "info",
        done.remuxed ? t("rec.saved", { path: done.path }) : t("rec.savedMkv", { path: done.path }),
      );
      // Só aparece quando o log foi preservado — em take limpo ele é apagado.
      if (done.logPath) pushToast("info", t("rec.logKept", { path: done.logPath }));
    } catch (e) {
      pushToast("error", t("rec.stopFailed", { error: String(e) }));
    } finally {
      setPhase("idle");
      setProgress(ZERO);
    }
  };

  // A tela principal é sintética (id "primary" vindo do Rust) — o rótulo é
  // nosso e traduzido. Monitores de verdade chegam depois.
  const screenLabel = (d: Device) => (d.id === PRIMARY_SCREEN ? t("sources.screenPrimary") : d.label);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">LocalRecord</span>
        <span className="muted tagline">{t("top.tagline")}</span>
        <div className="toolbar-fill" />
        <button title={t("top.settingsTitle")} onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </div>

      {!ffOk && (
        <div className="banner">
          <span>⚠</span>
          <span>{t("warn.noFfmpeg")}</span>
        </div>
      )}

      <div className="grid">
        <div className="col">
          <div className="card">
            <div className="card-head">
              <strong>{t("sources.title")}</strong>
              <button className="small" onClick={() => void load()} disabled={loading || !isTauri || busy}>
                {t("sources.refresh")}
              </button>
            </div>

            {loading ? (
              <p className="muted small">{t("sources.loading")}</p>
            ) : (
              <>
                <SourceSelect
                  label={t("sources.screen")}
                  devices={devices.screens}
                  value={screen}
                  onChange={setScreen}
                  labelFor={screenLabel}
                  disabled={busy}
                />
                <SourceSelect
                  label={t("sources.camera")}
                  devices={devices.cameras}
                  value={camera}
                  onChange={setCamera}
                  emptyLabel={t("sources.none")}
                  disabled={busy}
                />
                <SourceSelect
                  label={t("sources.mic")}
                  devices={devices.microphones}
                  value={mic}
                  onChange={setMic}
                  emptyLabel={t("sources.noMic")}
                  disabled={busy}
                />
                {mic && (
                  <div className="source-row">
                    <span />
                    <AudioMeter
                      peak={levels.mic}
                      error={micMeterErr ? t("audio.meterFailed", { error: micMeterErr }) : null}
                    />
                  </div>
                )}

                {/* Áudio do sistema: o que o computador está TOCANDO, capturado
                    por WASAPI loopback no Rust (não pelo dshow — ver
                    src-tauri/src/sysaudio.rs). */}
                <div className="source-row">
                  <span className="muted">{t("audio.sysAudio")}</span>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={sysOn}
                      disabled={busy || !!sysErr}
                      onChange={(e) => setSysOn(e.target.checked)}
                    />
                    <span>{t("audio.sysArm")}</span>
                  </label>
                </div>

                {sysErr ? (
                  // Não dá aqui, e a tela DIZ por quê (sem placa de saída, Linux,
                  // driver recusando). Checkbox cinza e mudo faria o usuário
                  // procurar o problema nele mesmo.
                  <div className="source-row">
                    <span />
                    <p className="muted small meter-msg">
                      {t("audio.sysUnavailable", { error: sysErr })}
                    </p>
                  </div>
                ) : (
                  sysOn && (
                    <>
                      <SourceSelect
                        label={t("sources.output")}
                        devices={devices.outputs}
                        value={output}
                        onChange={setOutput}
                        disabled={busy}
                      />
                      <div className="source-row">
                        <span />
                        <AudioMeter
                          peak={levels.system}
                          error={
                            sysMeterErr ? t("audio.meterFailed", { error: sysMeterErr }) : null
                          }
                        />
                      </div>
                      <p className="muted small">{t("audio.sysHint")}</p>
                      {mic && (
                        <>
                          {/* Faixas separadas só com as DUAS fontes: "separar"
                              uma fonte só não quer dizer nada. */}
                          <div className="source-row">
                            <span className="muted">{t("audio.tracks")}</span>
                            <select
                              value={tracks}
                              disabled={busy}
                              onChange={(e) => setTracks(e.target.value as AudioTracks)}
                            >
                              <option value="mixed">{t("audio.tracksMixed")}</option>
                              <option value="separate">{t("audio.tracksSeparate")}</option>
                            </select>
                          </div>
                          {tracks === "separate" && (
                            <p className="muted small">{t("audio.tracksHint")}</p>
                          )}
                        </>
                      )}
                    </>
                  )
                )}

                {devices.screens.length === 0 && <p className="muted small">{t("sources.empty")}</p>}
              </>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <strong>{t("out.title")}</strong>
              <span className="muted small">
                {t("out.encoder")}: {encoder || t("out.encoderProbing")}
              </span>
            </div>
            <div className="source-row">
              <span className="muted">{t("out.folder")}</span>
              <input value={outDir} onChange={(e) => setOutDir(e.target.value)} disabled={busy} />
            </div>
            <div className="source-row">
              <span className="muted">{t("out.pattern")}</span>
              <input value={pattern} onChange={(e) => setPattern(e.target.value)} disabled={busy} />
            </div>
            <p className="muted small">{t("out.patternHint")}</p>
          </div>

          {/* O pilar. Fica ao lado da saída e NÃO é travado por `busy`: armar
              ou desarmar o overlay no meio da gravação é caso de uso, não
              acidente — o professor decide na hora que precisa riscar algo. */}
          <div className="card">
            <div className="card-head">
              <strong>{t("annot.title")}</strong>
              <span className={`annot-led${annot.pen ? " on" : ""}`} />
            </div>
            <label className="check">
              <input type="checkbox" checked={annot.armed} onChange={(e) => void arm(e.target.checked)} />
              <span>{t("annot.arm")}</span>
            </label>
            <p className="muted small">
              {annot.armed ? t("annot.armed", { pen: SC_PEN }) : t("annot.disarmed")}
            </p>
            {annot.armed && (
              <>
                <p className="muted small">{t("annot.hint", { pen: SC_PEN, clear: SC_CLEAR })}</p>
                <p className="muted small">{t("annot.burnedIn")}</p>
              </>
            )}
          </div>
        </div>

        <div className="col">
          <Preview
            grabber={GRABBER}
            cameraId={camera}
            corner={corner}
            sizePct={sizePct}
            onCornerChange={setCorner}
            disabled={busy}
          />
          {camera && (
            <div className="card">
              <div className="size-row">
                <span className="muted">{t("preview.camSize")}</span>
                <input
                  type="range"
                  min={10}
                  max={40}
                  value={sizePct}
                  disabled={busy}
                  onChange={(e) => setSizePct(Number(e.target.value))}
                />
                <span className="muted small">{sizePct}%</span>
              </div>
            </div>
          )}

          {/* Fica FORA do bloco da câmera: o alvo vale pra gravação inteira,
              com câmera ou sem. */}
          <div className="card">
            <div className="size-row">
              <span className="muted">{t("rec.fpsTarget")}</span>
              <select
                value={fps}
                disabled={busy}
                onChange={(e) => setFps(Number(e.target.value) as TargetFps)}
              >
                {FPS_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} fps
                  </option>
                ))}
              </select>
            </div>
            <p className="muted small">{t("rec.fpsTargetHint")}</p>
          </div>
        </div>
      </div>

      <div className="rec-bar">
        {phase === "recording" || phase === "stopping" ? (
          <button className="primary rec-btn stop" onClick={() => void stop()} disabled={phase === "stopping"}>
            ■ {t("rec.stop")}
          </button>
        ) : (
          <button className="primary rec-btn" onClick={start} disabled={!canRecord}>
            ● {t("rec.start")}
          </button>
        )}

        {phase === "countdown" && (
          <>
            <span className="countdown">{t("rec.countdown", { n: count })}</span>
            {/* Dito AQUI, e não num toast depois: a janela vai minimizar em
                segundos — um aviso mostrado depois disso ninguém leria. */}
            <span className="muted small">{t("rec.minimized")}</span>
          </>
        )}
        {phase === "recording" && (
          <>
            <span className="rec-dot" />
            <span className="timer">{formatDuration(progress.elapsedMs)}</span>
            <span className="muted small">
              {t("rec.stats", {
                size: formatBytes(progress.sizeBytes),
                fps: progress.fps || "—",
              })}
            </span>
          </>
        )}
        {phase === "stopping" && <span className="muted small">{t("rec.stopping")}</span>}
      </div>

      <SettingsModal />
      <Toasts />
    </div>
  );
}
