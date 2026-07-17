import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Preview from "./components/Preview";
import SettingsModal from "./components/SettingsModal";
import Toasts from "./components/Toasts";
import {
  buildRecordArgs,
  buildRemuxArgs,
  expandPattern,
  type Corner,
  type Encoder,
  type Grabber,
  type Platform,
  type RecordSpec,
} from "./lib/args";
import { t } from "./lib/i18n";
import {
  formatBytes,
  formatDuration,
  pickDefault,
  PRIMARY_SCREEN,
  type Device,
  type DeviceList,
} from "./lib/sources";
import { useUi } from "./state/ui";

// Fora do Tauri (smoke no navegador com `npm run preview`) não há back: a UI
// renderiza vazia em vez de estourar no invoke.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const EMPTY: DeviceList = { screens: [], cameras: [], microphones: [] };

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
}

interface AnnotSnapshot {
  armed: boolean;
  pen: boolean;
}

/** Os mesmos atalhos de `annot.rs` — aqui só pra MOSTRAR ao usuário. Quem
 *  registra de verdade é o Rust; isto é rótulo, não configuração. */
const SC_PEN = "Ctrl+Shift+D";
const SC_CLEAR = "Ctrl+Shift+X";

const platform: Platform =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows") ? "windows" : "linux";

/** A tela é capturada pela DDA no Windows (GPU) e pelo x11grab no Linux.
 *  O gdigrab não entra aqui: ele é só o plano B, montado no `rec_start`. */
const GRABBER: Grabber = platform === "windows" ? "ddagrab" : "x11grab";

const FPS = 30;
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

  const [devices, setDevices] = useState<DeviceList>(EMPTY);
  const [loading, setLoading] = useState(isTauri);
  const [ffOk, setFfOk] = useState(true); // otimista: só avisa depois de confirmar
  const [screen, setScreen] = useState("");
  const [camera, setCamera] = useState("");
  const [mic, setMic] = useState("");

  const [corner, setCorner] = useState<Corner>("br");
  const [sizePct, setSizePct] = useState(25);
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
    } catch (e) {
      pushToast("error", t("sources.loadFailed", { error: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (!isTauri) return;
    invoke<boolean>("ffmpeg_ok").then(setFfOk).catch(() => setFfOk(false));
    void load();
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
  }, [load]);

  // Progresso vem do próprio ffmpeg (`-progress pipe:1`), não de um cronômetro
  // nosso: o número na tela é o tempo que foi REALMENTE parar no arquivo.
  useEffect(() => {
    if (!isTauri) return;
    const un = [
      listen<RecProgress>("rec-progress", (e) => setProgress(e.payload)),
      listen<string>("rec-notice", (e) => pushToast("info", t("rec.fallback", { error: e.payload }))),
      // O atalho global liga a caneta sem passar por esta janela — sem ouvir
      // isto, o painel mentiria sobre o estado do overlay.
      listen<AnnotSnapshot>("annot-state", (e) => setAnnot(e.payload)),
    ];
    return () => {
      for (const p of un) void p.then((f) => f());
    };
  }, [pushToast]);

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

      const spec: RecordSpec = {
        platform,
        grabber: GRABBER,
        fps: FPS,
        camera: camera ? { id: camera, corner, sizePct } : null,
        mic: mic || null,
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
        },
      });
      setPhase("recording");
    } catch (e) {
      // Deu errado: a janela VOLTA. Ficar minimizada depois de um erro deixaria
      // o usuário achando que o app sumiu.
      if (isTauri) await getCurrentWindow().unminimize().catch(() => {});
      setPhase("idle");
      pushToast("error", t("rec.failed", { error: String(e) }));
    }
  }, [camera, corner, encoder, mic, outDir, pattern, pushToast, sizePct]);

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
      // Ordem das mensagens: primeiro o aviso do kill (contexto), depois onde o
      // arquivo ficou (a informação que o usuário foi buscar).
      if (!done.graceful) pushToast("info", t("rec.killed"));
      pushToast(
        done.remuxed ? "ok" : "info",
        done.remuxed ? t("rec.saved", { path: done.path }) : t("rec.savedMkv", { path: done.path }),
      );
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

                {/* Áudio do sistema: fora do escopo desta onda. O controle fica
                    visível e desligado de propósito — some seria pior, o usuário
                    ficaria procurando o que não existe ainda. */}
                <div className="source-row">
                  <span className="muted">{t("out.sysAudio")}</span>
                  <label className="check" title={t("out.sysAudioSoon")}>
                    <input type="checkbox" disabled checked={false} readOnly />
                    <span className="muted small">{t("out.sysAudioSoon")}</span>
                  </label>
                </div>

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
