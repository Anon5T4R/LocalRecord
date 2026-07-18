/** Persistência do SETUP de gravação (as "boxes marcadas") entre sessões.
 *
 *  Por que um módulo à parte e PURO: a parte perigosa não é gravar/ler o
 *  localStorage — é a RECONCILIAÇÃO. Um dispositivo salvo (câmera, mic, saída)
 *  pode ter sido desplugado desde a última sessão. Restaurar um id de device
 *  que sumiu e deixar o ffmpeg falhar na hora de gravar é PIOR que não
 *  restaurar nada. Toda essa lógica mora aqui, em funções puras, pra ser
 *  cravada em teste (é exatamente onde mora o bug).
 */

import type { AudioTracks, Corner } from "./args";
import { PRIMARY_SCREEN, pickDefault, type Device, type DeviceList } from "./sources";

export const SETUP_KEY = "localrecord.setup";

/** O que sobrevive ao fechar o app. Só o SETUP de gravação — nada de estado de
 *  gravação em andamento (isso é reconciliado pelo Rust via `rec_status`). */
export interface Setup {
  /** Dispositivos (ids crus, como o ffmpeg quer). Todos passam pela
   *  reconciliação: o que sumiu cai no default, NUNCA vira device fantasma. */
  screen: string;
  camera: string;
  mic: string;
  output: string;
  /** Flag do áudio do sistema (o checkbox da v0.2). A saída (`output`) só
   *  importa quando isto é `true`. */
  sysOn: boolean;
  /** Layout — sem risco de "sumir", restaurados direto (com clamp/validação). */
  tracks: AudioTracks;
  corner: Corner;
  sizePct: number;
  /** Rótulos dos dispositivos escolhidos no momento do save. Só servem pra dar
   *  NOME ao aviso quando um deles some: uma vez desplugado, o device não está
   *  mais na lista atual, então não dá pra descobrir o rótulo na hora de
   *  reconciliar — tem que ter sido guardado antes. Não é fonte da verdade de
   *  nada; se faltar, o aviso cai no próprio id. */
  labels: Record<string, string>;
}

/** Faixa do slider de tamanho da câmera (App.tsx: min=10 max=40). O clamp mora
 *  aqui pra um sizePct corrompido no storage não escapar pro ffmpeg. */
export const SIZE_MIN = 10;
export const SIZE_MAX = 40;

export const DEFAULT_SETUP: Setup = {
  screen: "",
  camera: "",
  mic: "",
  output: "",
  sysOn: false,
  tracks: "mixed",
  corner: "br",
  sizePct: 25,
  labels: {},
};

const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];
const TRACKS: readonly AudioTracks[] = ["mixed", "separate"];

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Que TIPO de device sumiu — só os que o usuário escolhe explicitamente e que
 *  o aviso faz sentido mencionar. A tela não entra: ela sempre resolve pra uma
 *  tela válida (a principal) e "voltei pra tela principal" não é notícia. */
export type DroppedKind = "camera" | "mic" | "output";

export interface DroppedDevice {
  kind: DroppedKind;
  /** O rótulo salvo (ou o id, se não tínhamos rótulo) — pro aviso discreto. */
  label: string;
}

export interface Reconciled {
  /** Setup pronto pra aplicar: todo device aqui EXISTE na lista atual. */
  setup: Setup;
  /** Devices que estavam salvos e sumiram — pro aviso traduzido na UI. */
  dropped: DroppedDevice[];
}

/** Lê o setup salvo (cru, pode estar parcial/corrompido) sem aplicar nada. */
export function loadSetup(): Partial<Setup> | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SETUP_KEY) : null;
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Partial<Setup>) : null;
  } catch {
    return null;
  }
}

export function saveSetup(setup: Setup): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch {
    /* localStorage indisponível — perder a persistência não pode quebrar a UI */
  }
}

/** Monta o mapa id→label dos dispositivos ESCOLHIDOS, pro save guardar o nome
 *  de cada um (ver o campo `labels` do Setup). */
export function labelsFor(list: DeviceList, ids: string[]): Record<string, string> {
  const all: Device[] = [...list.screens, ...list.cameras, ...list.microphones, ...list.outputs];
  const out: Record<string, string> = {};
  for (const id of ids) {
    if (!id) continue;
    const d = all.find((x) => x.id === id);
    if (d) out[id] = d.label;
  }
  return out;
}

/**
 * O CORAÇÃO da tarefa: pega o setup salvo (cru) + a lista de dispositivos que
 * REALMENTE existem agora e devolve um setup seguro de aplicar.
 *
 * Regras:
 *  - Cada device salvo é validado contra a lista atual. Se sobreviveu, fica; se
 *    sumiu, cai no default (tela → principal; câmera/mic → "nenhum"; saída →
 *    saída padrão) e entra em `dropped` pra UI avisar. NUNCA volta um id morto.
 *  - Layout (corner, tracks, sizePct) não tem esse risco: restaura direto, mas
 *    com validação/clamp pra storage corrompido não vazar pro ffmpeg.
 *  - A saída de áudio só é reportada como "sumiu" quando `sysOn`: sem o áudio
 *    do sistema ligado ela nem entra na gravação, avisar seria ruído.
 */
export function reconcileSetup(saved: Partial<Setup> | null, list: DeviceList): Reconciled {
  const s = saved ?? {};
  const labels = (s.labels && typeof s.labels === "object" ? s.labels : {}) as Record<string, string>;
  const dropped: DroppedDevice[] = [];

  const nameOf = (id: string) => labels[id] ?? id;

  // Tela: sempre resolve pra algo válido (principal, ou a 1a da lista). Sem
  // reportar drop — ver DroppedKind.
  const screen = pickDefault(list.screens, s.screen ?? "", PRIMARY_SCREEN);

  // Câmera: opcional. Se o id salvo não existe mais, pickDefault devolve "".
  const savedCamera = s.camera ?? "";
  const camera = pickDefault(list.cameras, savedCamera);
  if (savedCamera && camera !== savedCamera) dropped.push({ kind: "camera", label: nameOf(savedCamera) });

  const savedMic = s.mic ?? "";
  const mic = pickDefault(list.microphones, savedMic);
  if (savedMic && mic !== savedMic) dropped.push({ kind: "mic", label: nameOf(savedMic) });

  // Saída: default é a primeira da lista (contrato do sysaudio).
  const savedOutput = s.output ?? "";
  const output = pickDefault(list.outputs, savedOutput, list.outputs[0]?.id ?? "");
  const sysOn = s.sysOn === true;
  // Só avisa se o áudio do sistema estava ligado — senão a saída nem seria usada.
  if (sysOn && savedOutput && output !== savedOutput) {
    dropped.push({ kind: "output", label: nameOf(savedOutput) });
  }

  const tracks = TRACKS.includes(s.tracks as AudioTracks) ? (s.tracks as AudioTracks) : "mixed";
  const corner = CORNERS.includes(s.corner as Corner) ? (s.corner as Corner) : "br";
  const sizePct = clamp(s.sizePct as number, SIZE_MIN, SIZE_MAX, DEFAULT_SETUP.sizePct);

  return {
    setup: { screen, camera, mic, output, sysOn, tracks, corner, sizePct, labels },
    dropped,
  };
}
