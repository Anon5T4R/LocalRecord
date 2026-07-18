import { useSyncExternalStore } from "react";

/** i18n leve da UI (padrão da suíte, ver docs/planos/padrao-apps.md). */

export type Locale = "pt" | "en" | "es";

export const LOCALE_LABELS: Record<Locale, string> = {
  pt: "Português",
  en: "English",
  es: "Español",
};

const LOCALE_KEY = "localrecord.locale";

const pt = {
  "top.settingsTitle": "Configurações",
  "top.tagline": "Estúdio de captura",

  "warn.noFfmpeg":
    "Runtime de mídia ausente — sem o ffmpeg o LocalRecord não grava. Rode scripts/fetch-ffmpeg (o instalador já traz).",

  "sources.title": "Fontes",
  "sources.screen": "Tela",
  "sources.camera": "Câmera",
  "sources.mic": "Microfone",
  "sources.output": "Saída de áudio",
  "sources.none": "Nenhuma",
  "sources.noMic": "Sem áudio",
  "sources.screenPrimary": "Tela principal",
  "sources.loading": "Procurando dispositivos…",
  "sources.empty": "Nenhum dispositivo encontrado",
  "sources.refresh": "Procurar de novo",
  "sources.loadFailed": "Não deu pra listar os dispositivos: {error}",

  "setup.cameraGone": "A câmera “{device}” não está mais disponível — voltei pra sem câmera.",
  "setup.micGone": "O microfone “{device}” não está mais disponível — voltei pra sem áudio.",
  "setup.outputGone": "A saída de áudio “{device}” não está mais disponível — voltei pra saída padrão.",

  "preview.title": "Prévia",
  "preview.hint": "Arraste a câmera pro canto que você quiser — é exatamente assim que ela entra no vídeo.",
  "preview.hintNoCam": "Escolha uma câmera pra sobrepor no canto da tela.",
  "preview.noShot": "Sem prévia da tela",
  "preview.camFailed": "Não deu pra abrir a câmera na prévia: {error}",
  "preview.camSize": "Tamanho da câmera",

  "out.title": "Saída",
  "out.folder": "Pasta",
  "out.pattern": "Nome do arquivo",
  "out.patternHint": "Use {date} e {time} — a gravação nunca sobrescreve outra.",
  "out.encoder": "Codificador",
  "out.encoderProbing": "testando…",

  "audio.sysAudio": "Áudio do sistema",
  "audio.sysArm": "Gravar o que o computador está tocando",
  "audio.sysUnavailable": "Não dá pra gravar o áudio do sistema aqui: {error}",
  "audio.sysHint": "Toque alguma coisa pra ver o nível mexer — se a barra não sobe, não está entrando som.",
  "audio.meterFailed": "Sem medidor pra esta fonte: {error}",
  "audio.tracks": "Faixas",
  "audio.tracksMixed": "Mixadas (uma faixa)",
  "audio.tracksSeparate": "Separadas (uma por fonte)",
  "audio.tracksHint": "Separadas: o microfone e o áudio do sistema vão em faixas próprias, pra você equilibrar o volume de cada um na edição.",

  "rec.start": "Gravar",
  "rec.stop": "Parar",
  "rec.countdown": "Começa em {n}…",
  "rec.stopping": "Fechando o arquivo…",
  "rec.stats": "{size} · {fps} fps",
  "rec.saved": "Gravação salva em {path}",
  "rec.savedMkv": "O remux pra MP4 falhou, mas o take está salvo (MKV): {path}",
  "rec.killed": "O ffmpeg não fechou no prazo e foi encerrado à força — o take foi salvo assim mesmo.",
  "rec.fallback": "A captura por GPU não subiu ({error}). Gravando pelo modo compatível (gdigrab).",
  "rec.failed": "Não deu pra gravar: {error}",
  "rec.stopFailed": "Não deu pra parar direito: {error}",
  "rec.needScreen": "Escolha uma tela pra gravar.",
  "rec.sysAudioOff": "Gravando SEM o áudio do sistema: {error}",
  "rec.sysAudioLost": "O áudio do sistema parou no meio da gravação ({error}) — daquele ponto em diante o take está em silêncio de verdade.",
  "rec.captureLost": "A captura da tela parou no meio da gravação — o áudio continua, mas o vídeo congelou. O take foi salvo assim mesmo; confira antes de usar.",
  "rec.logKept": "Guardei o log do ffmpeg deste take em {path} — é por onde se descobre o que deu errado.",
  "rec.minimized": "O LocalRecord se recolheu pra não aparecer no vídeo — volte por ele pela barra de tarefas pra parar a gravação.",

  "annot.title": "Anotação ao vivo",
  "annot.arm": "Anotar por cima da tela",
  "annot.armed": "Overlay ligado — a caneta entra por {pen}.",
  "annot.disarmed": "Desligado. Ligue pra riscar a tela enquanto grava.",
  "annot.hint": "{pen} liga/desliga a caneta · {clear} limpa tudo. Com a caneta desligada o clique passa direto pro app de baixo.",
  "annot.burnedIn": "O que você riscar entra no vídeo (e a plateia vê ao vivo).",
  "annot.failed": "Não deu pra ligar o overlay: {error}",
  "annot.pen": "Caneta",
  "annot.text": "Texto",
  "annot.eraser": "Borracha",
  "annot.clear": "Limpar tudo",
  "annot.color": "Cor",
  "annot.width": "Espessura",
  "annot.penOff": "Guardar a caneta (o clique volta a passar)",
  "annot.drag": "Arraste a barra pra fora do caminho",
  "annot.textPlaceholder": "Digite e aperte Enter",

  "dlg.ok": "OK",

  "settings.title": "Configurações",
  "settings.theme": "Tema",
  "settings.themeSystem": "Sistema",
  "settings.themeLight": "Claro",
  "settings.themeDark": "Escuro",
  "settings.themeNature": "Natureza",
  "settings.themeDarkBlue": "Azul escuro",
  "settings.themeCalmGreen": "Verde calmo",
  "settings.themePastelPink": "Rosa pastel",
  "settings.themePunkPrincess": "PunkPrincess",
  "settings.language": "Idioma",
  "settings.about":
    " — estúdio de captura de tela 100% offline: grava a tela com a câmera no canto e anota AO VIVO por cima. Nada sobe pra lugar nenhum. Parte da suíte Local.",
} as const;

export type MessageKey = keyof typeof pt;

const en: Record<MessageKey, string> = {
  "top.settingsTitle": "Settings",
  "top.tagline": "Capture studio",

  "warn.noFfmpeg":
    "Media runtime missing — without ffmpeg, LocalRecord can't record. Run scripts/fetch-ffmpeg (the installer ships with it).",

  "sources.title": "Sources",
  "sources.screen": "Screen",
  "sources.camera": "Camera",
  "sources.mic": "Microphone",
  "sources.output": "Audio output",
  "sources.none": "None",
  "sources.noMic": "No audio",
  "sources.screenPrimary": "Primary screen",
  "sources.loading": "Looking for devices…",
  "sources.empty": "No devices found",
  "sources.refresh": "Look again",
  "sources.loadFailed": "Couldn't list the devices: {error}",

  "setup.cameraGone": "The camera “{device}” isn't available anymore — switched back to no camera.",
  "setup.micGone": "The microphone “{device}” isn't available anymore — switched back to no audio.",
  "setup.outputGone": "The audio output “{device}” isn't available anymore — switched back to the default output.",

  "preview.title": "Preview",
  "preview.hint": "Drag the camera to whichever corner you want — that's exactly how it lands in the video.",
  "preview.hintNoCam": "Pick a camera to overlay in the corner of the screen.",
  "preview.noShot": "No screen preview",
  "preview.camFailed": "Couldn't open the camera in the preview: {error}",
  "preview.camSize": "Camera size",

  "out.title": "Output",
  "out.folder": "Folder",
  "out.pattern": "File name",
  "out.patternHint": "Use {date} and {time} — a recording never overwrites another.",
  "out.encoder": "Encoder",
  "out.encoderProbing": "testing…",

  "audio.sysAudio": "System audio",
  "audio.sysArm": "Record what the computer is playing",
  "audio.sysUnavailable": "System audio can't be recorded here: {error}",
  "audio.sysHint": "Play something and watch the level move — if the bar doesn't rise, no sound is coming in.",
  "audio.meterFailed": "No level meter for this source: {error}",
  "audio.tracks": "Tracks",
  "audio.tracksMixed": "Mixed (one track)",
  "audio.tracksSeparate": "Separate (one per source)",
  "audio.tracksHint": "Separate: the microphone and the system audio land on their own tracks, so you can balance each one while editing.",

  "rec.start": "Record",
  "rec.stop": "Stop",
  "rec.countdown": "Starting in {n}…",
  "rec.stopping": "Closing the file…",
  "rec.stats": "{size} · {fps} fps",
  "rec.saved": "Recording saved to {path}",
  "rec.savedMkv": "The remux to MP4 failed, but the take is saved (MKV): {path}",
  "rec.killed": "ffmpeg didn't close in time and was force-stopped — the take was saved anyway.",
  "rec.fallback": "GPU capture didn't start ({error}). Recording in compatible mode (gdigrab).",
  "rec.failed": "Couldn't record: {error}",
  "rec.stopFailed": "Couldn't stop cleanly: {error}",
  "rec.needScreen": "Pick a screen to record.",
  "rec.sysAudioOff": "Recording WITHOUT system audio: {error}",
  "rec.sysAudioLost": "System audio stopped mid-recording ({error}) — from that point on the take is genuinely silent.",
  "rec.captureLost": "Screen capture stopped mid-recording — the audio kept going, but the video froze. The take was still saved; check it before using it.",
  "rec.logKept": "Kept this take's ffmpeg log at {path} — that's where you find out what went wrong.",
  "rec.minimized": "LocalRecord got out of the way so it doesn't show up in the video — bring it back from the taskbar to stop the recording.",

  "annot.title": "Live annotation",
  "annot.arm": "Annotate on top of the screen",
  "annot.armed": "Overlay on — the pen comes in with {pen}.",
  "annot.disarmed": "Off. Turn it on to draw on the screen while recording.",
  "annot.hint": "{pen} toggles the pen · {clear} clears everything. With the pen off, clicks go straight through to the app underneath.",
  "annot.burnedIn": "Whatever you draw lands in the video (and the live audience sees it).",
  "annot.failed": "Couldn't turn the overlay on: {error}",
  "annot.pen": "Pen",
  "annot.text": "Text",
  "annot.eraser": "Eraser",
  "annot.clear": "Clear everything",
  "annot.color": "Color",
  "annot.width": "Stroke width",
  "annot.penOff": "Put the pen away (clicks go through again)",
  "annot.drag": "Drag the bar out of the way",
  "annot.textPlaceholder": "Type and press Enter",

  "dlg.ok": "OK",

  "settings.title": "Settings",
  "settings.theme": "Theme",
  "settings.themeSystem": "System",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.themeNature": "Nature",
  "settings.themeDarkBlue": "Dark blue",
  "settings.themeCalmGreen": "Calm green",
  "settings.themePastelPink": "Pastel pink",
  "settings.themePunkPrincess": "PunkPrincess",
  "settings.language": "Language",
  "settings.about":
    " — 100% offline screen capture studio: record the screen with your camera in the corner and annotate LIVE on top. Nothing is uploaded anywhere. Part of the Local suite.",
};

const es: Record<MessageKey, string> = {
  "top.settingsTitle": "Configuración",
  "top.tagline": "Estudio de captura",

  "warn.noFfmpeg":
    "Falta el runtime de medios — sin ffmpeg, LocalRecord no graba. Ejecuta scripts/fetch-ffmpeg (el instalador ya lo incluye).",

  "sources.title": "Fuentes",
  "sources.screen": "Pantalla",
  "sources.camera": "Cámara",
  "sources.mic": "Micrófono",
  "sources.output": "Salida de audio",
  "sources.none": "Ninguna",
  "sources.noMic": "Sin audio",
  "sources.screenPrimary": "Pantalla principal",
  "sources.loading": "Buscando dispositivos…",
  "sources.empty": "No se encontraron dispositivos",
  "sources.refresh": "Buscar de nuevo",
  "sources.loadFailed": "No se pudieron listar los dispositivos: {error}",

  "setup.cameraGone": "La cámara «{device}» ya no está disponible — volví a sin cámara.",
  "setup.micGone": "El micrófono «{device}» ya no está disponible — volví a sin audio.",
  "setup.outputGone": "La salida de audio «{device}» ya no está disponible — volví a la salida predeterminada.",

  "preview.title": "Vista previa",
  "preview.hint": "Arrastra la cámara a la esquina que quieras — así es exactamente como entra en el vídeo.",
  "preview.hintNoCam": "Elige una cámara para superponer en la esquina de la pantalla.",
  "preview.noShot": "Sin vista previa de la pantalla",
  "preview.camFailed": "No se pudo abrir la cámara en la vista previa: {error}",
  "preview.camSize": "Tamaño de la cámara",

  "out.title": "Salida",
  "out.folder": "Carpeta",
  "out.pattern": "Nombre del archivo",
  "out.patternHint": "Usa {date} y {time} — una grabación nunca sobrescribe a otra.",
  "out.encoder": "Codificador",
  "out.encoderProbing": "probando…",

  "audio.sysAudio": "Audio del sistema",
  "audio.sysArm": "Grabar lo que está sonando en el ordenador",
  "audio.sysUnavailable": "Aquí no se puede grabar el audio del sistema: {error}",
  "audio.sysHint": "Reproduce algo y mira si el nivel se mueve — si la barra no sube, no está entrando sonido.",
  "audio.meterFailed": "Sin medidor para esta fuente: {error}",
  "audio.tracks": "Pistas",
  "audio.tracksMixed": "Mezcladas (una pista)",
  "audio.tracksSeparate": "Separadas (una por fuente)",
  "audio.tracksHint": "Separadas: el micrófono y el audio del sistema van en pistas propias, para equilibrar el volumen de cada uno al editar.",

  "rec.start": "Grabar",
  "rec.stop": "Parar",
  "rec.countdown": "Empieza en {n}…",
  "rec.stopping": "Cerrando el archivo…",
  "rec.stats": "{size} · {fps} fps",
  "rec.saved": "Grabación guardada en {path}",
  "rec.savedMkv": "El remux a MP4 falló, pero la toma está guardada (MKV): {path}",
  "rec.killed": "ffmpeg no cerró a tiempo y se detuvo a la fuerza — la toma se guardó igualmente.",
  "rec.fallback": "La captura por GPU no arrancó ({error}). Grabando en modo compatible (gdigrab).",
  "rec.failed": "No se pudo grabar: {error}",
  "rec.stopFailed": "No se pudo parar limpiamente: {error}",
  "rec.needScreen": "Elige una pantalla para grabar.",
  "rec.sysAudioOff": "Grabando SIN el audio del sistema: {error}",
  "rec.sysAudioLost": "El audio del sistema se cortó a mitad de la grabación ({error}) — a partir de ahí la toma está de verdad en silencio.",
  "rec.captureLost": "La captura de pantalla se detuvo a mitad de la grabación — el audio siguió, pero el video se congeló. La toma se guardó igual; revísala antes de usarla.",
  "rec.logKept": "Guardé el registro de ffmpeg de esta toma en {path} — ahí se descubre qué salió mal.",
  "rec.minimized": "LocalRecord se apartó para no salir en el vídeo — recupéralo desde la barra de tareas para parar la grabación.",

  "annot.title": "Anotación en vivo",
  "annot.arm": "Anotar sobre la pantalla",
  "annot.armed": "Overlay activo — el lápiz entra con {pen}.",
  "annot.disarmed": "Apagado. Actívalo para dibujar en la pantalla mientras grabas.",
  "annot.hint": "{pen} activa/desactiva el lápiz · {clear} borra todo. Con el lápiz apagado, los clics pasan directo a la app de abajo.",
  "annot.burnedIn": "Lo que dibujes entra en el vídeo (y el público en vivo lo ve).",
  "annot.failed": "No se pudo activar el overlay: {error}",
  "annot.pen": "Lápiz",
  "annot.text": "Texto",
  "annot.eraser": "Goma",
  "annot.clear": "Borrar todo",
  "annot.color": "Color",
  "annot.width": "Grosor",
  "annot.penOff": "Guardar el lápiz (los clics vuelven a pasar)",
  "annot.drag": "Arrastra la barra fuera del camino",
  "annot.textPlaceholder": "Escribe y pulsa Enter",

  "dlg.ok": "OK",

  "settings.title": "Configuración",
  "settings.theme": "Tema",
  "settings.themeSystem": "Sistema",
  "settings.themeLight": "Claro",
  "settings.themeDark": "Oscuro",
  "settings.themeNature": "Naturaleza",
  "settings.themeDarkBlue": "Azul oscuro",
  "settings.themeCalmGreen": "Verde tranquilo",
  "settings.themePastelPink": "Rosa pastel",
  "settings.themePunkPrincess": "PunkPrincess",
  "settings.language": "Idioma",
  "settings.about":
    " — estudio de captura de pantalla 100% offline: graba la pantalla con la cámara en la esquina y anota EN VIVO por encima. Nada se sube a ningún lado. Parte de la suite Local.",
};

const DICTS: Record<Locale, Record<MessageKey, string>> = { pt, en, es };

export function detectLocale(): Locale {
  const l = (typeof navigator !== "undefined" ? navigator.language : "pt").toLowerCase();
  if (l.startsWith("en")) return "en";
  if (l.startsWith("es")) return "es";
  return "pt";
}

function loadLocale(): Locale {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(LOCALE_KEY) : null;
  return v === "pt" || v === "en" || v === "es" ? v : detectLocale();
}

let current: Locale = loadLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale) {
  if (locale === current) return;
  current = locale;
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    /* localStorage indisponível */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let msg: string = DICTS[current][key] ?? pt[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.split(`{${k}}`).join(String(v));
    }
  }
  return msg;
}
