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
  /** Saída do áudio do sistema. `""` = SEGUIR A PADRÃO do Windows, resolvida na
   *  hora de gravar — e é o default. Fixar um nome aqui era o bug dos takes
   *  mudos de 2026-07-19: o app fixava a saída que era padrão QUANDO ELE ABRIU;
   *  o fone BT conectava depois, o Windows movia o som pra lá, e o loopback
   *  ficava escutando um endpoint parado — silêncio digital, sem erro nenhum.
   *  Nome preenchido = o usuário ESCOLHEU aquele device, e aí respeita-se. */
  output: string;
  /** Flag do áudio do sistema (o checkbox da v0.2). A saída (`output`) só
   *  importa quando isto é `true`. */
  sysOn: boolean;
  /** Filtro de ruído do MICROFONE (passa-alta + afftdn no grafo do ffmpeg).
   *  Desligado por padrão — filtro custa um pouco de voz e é escolha explícita. */
  micFilter: boolean;
  /** Layout — sem risco de "sumir", restaurados direto (com clamp/validação). */
  tracks: AudioTracks;
  corner: Corner;
  sizePct: number;
  /** Quadros por segundo que a gravação PEDE. Escolha do usuário desde a v0.5.1
   *  — 60 pra quem tem hardware e câmera que aguentam, 24 pra quem quer folga
   *  (webcam barata costuma não sustentar 30 e arrasta o resto junto). */
  fps: TargetFps;
  /** Rótulos dos dispositivos escolhidos no momento do save. Só servem pra dar
   *  NOME ao aviso quando um deles some: uma vez desplugado, o device não está
   *  mais na lista atual, então não dá pra descobrir o rótulo na hora de
   *  reconciliar — tem que ter sido guardado antes. Não é fonte da verdade de
   *  nada; se faltar, o aviso cai no próprio id. */
  labels: Record<string, string>;
}

/** Faixa do slider de tamanho da câmera (App.tsx: min=10 max=40). O clamp mora
 *  aqui pra um sizePct corrompido no storage não escapar pro ffmpeg. */
/** Os alvos oferecidos. Acima de 60 é gargalo sem uso: o LocalRecord grava aula
 *  e tutorial, não stream competitivo. Abaixo, 24 existe porque a direção que
 *  ajuda quem tem câmera fraca é PRA BAIXO, não pra cima. */
export const FPS_OPTIONS = [24, 30, 60] as const;
export type TargetFps = (typeof FPS_OPTIONS)[number];

export const SIZE_MIN = 10;
export const SIZE_MAX = 40;

export const DEFAULT_SETUP: Setup = {
  screen: "",
  camera: "",
  mic: "",
  output: "",
  sysOn: false,
  micFilter: false,
  tracks: "mixed",
  corner: "br",
  sizePct: 25,
  fps: 30,
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

  // Saída: o default é "" = SEGUIR A PADRÃO do Windows (resolvida pelo Rust na
  // hora de capturar). Era `outputs[0]` — a padrão do MOMENTO DO BOOT — e isso
  // fixava o endpoint: fone BT conectado depois movia o som pra outro lugar e o
  // loopback gravava silêncio do endpoint parado, sem erro (takes de
  // 2026-07-19). Só um nome que o USUÁRIO escolheu sobrevive aqui.
  const savedOutput = s.output ?? "";
  const output = pickDefault(list.outputs, savedOutput);
  const sysOn = s.sysOn === true;
  // Só avisa se o áudio do sistema estava ligado — senão a saída nem seria usada.
  if (sysOn && savedOutput && output !== savedOutput) {
    dropped.push({ kind: "output", label: nameOf(savedOutput) });
  }

  const tracks = TRACKS.includes(s.tracks as AudioTracks) ? (s.tracks as AudioTracks) : "mixed";
  const corner = CORNERS.includes(s.corner as Corner) ? (s.corner as Corner) : "br";
  const sizePct = clamp(s.sizePct as number, SIZE_MIN, SIZE_MAX, DEFAULT_SETUP.sizePct);
  // Lista fechada, não faixa: um fps arbitrário vindo de storage corrompido iria
  // direto pro ffmpeg e pra escolha do modo da câmera.
  const fps = (FPS_OPTIONS as readonly number[]).includes(s.fps as number)
    ? (s.fps as TargetFps)
    : DEFAULT_SETUP.fps;

  const micFilter = s.micFilter === true;

  return {
    setup: { screen, camera, mic, output, sysOn, micFilter, tracks, corner, sizePct, fps, labels },
    dropped,
  };
}
