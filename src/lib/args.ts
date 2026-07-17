/** Montagem dos argumentos do ffmpeg da GRAVAÇÃO — funções PURAS (unit-testadas).
 *
 *  Regra da casa (gotcha #7): o Rust só resolve o binário e move bytes; quem
 *  decide QUAIS argumentos o ffmpeg recebe é este arquivo. Vale também pro
 *  remux do fim (`buildRemuxArgs`) — o `rec_stop` não inventa args, recebe.
 *
 *  O Rust injeta `-hide_banner -y -progress pipe:1 -loglevel error`; aqui entra
 *  só o que muda por gravação. Atenção: NÃO existe `-nostdin` aqui (ao contrário
 *  do LocalMedia) — o stdin é justamente por onde o `q` do stop gracioso entra.
 */

export type Corner = "tl" | "tr" | "bl" | "br";
export type Platform = "windows" | "linux";

/** Como a tela é capturada. `ddagrab` = Desktop Duplication API (GPU, Windows);
 *  `gdigrab` = fallback velho e lento, mas que funciona onde a DDA falha
 *  (sessão RDP, driver antigo); `x11grab` = Linux. */
export type Grabber = "ddagrab" | "gdigrab" | "x11grab";

/** Ordem de preferência real: hardware primeiro, x264 como rede de segurança.
 *  Quem ESCOLHE é o `rec_pick_encoder` do Rust, que testa de verdade — listar
 *  em `-encoders` não prova que o hardware existe (ver record.rs). */
export type Encoder = "h264_nvenc" | "h264_qsv" | "h264_amf" | "libx264";

export interface CameraSpec {
  /** Id CRU do dispositivo, como o ffmpeg quer (`video=<id>` no dshow). */
  id: string;
  corner: Corner;
  /** Largura da câmera em % da largura da TELA (o preview manda este número). */
  sizePct: number;
}

export interface RecordSpec {
  platform: Platform;
  grabber: Grabber;
  fps: number;
  camera: CameraSpec | null;
  /** Id do microfone, ou null pra gravar mudo. */
  mic: string | null;
  encoder: Encoder;
  /** Arquivo de saída — sempre .mkv (recuperável se faltar luz). */
  outPath: string;
}

/** Margem da câmera até a borda, em pixels do vídeo final. */
const MARGIN = 16;

/** Posição do overlay por canto. `W`/`H` = tela, `w`/`h` = câmera já escalada. */
function overlayXY(corner: Corner): string {
  switch (corner) {
    case "tl":
      return `${MARGIN}:${MARGIN}`;
    case "tr":
      return `W-w-${MARGIN}:${MARGIN}`;
    case "bl":
      return `${MARGIN}:H-h-${MARGIN}`;
    case "br":
      return `W-w-${MARGIN}:H-h-${MARGIN}`;
  }
}

/** Args de ENTRADA da tela + o começo da cadeia de filtros que ela precisa.
 *
 *  O `ddagrab` é um filtro-fonte do lavfi (não um `-f ddagrab`) e entrega quadro
 *  na GPU (D3D11) — daí o `hwdownload,format=bgra` pra trazer pra CPU. Os outros
 *  dois já chegam em CPU e não precisam de nada. */
function screenInput(s: RecordSpec): { args: string[]; chain: string } {
  switch (s.grabber) {
    case "ddagrab":
      return {
        args: ["-f", "lavfi", "-i", `ddagrab=output_idx=0:framerate=${s.fps}`],
        chain: "hwdownload,format=bgra",
      };
    case "gdigrab":
      return { args: ["-f", "gdigrab", "-framerate", String(s.fps), "-i", "desktop"], chain: "" };
    case "x11grab":
      return { args: ["-f", "x11grab", "-framerate", String(s.fps), "-i", ":0.0"], chain: "" };
  }
}

/** Args de qualidade do encoder escolhido.
 *
 *  Cada família tem seu botão de qualidade — não existe `-crf` universal. Os
 *  valores miram "bom o bastante pra tutorial, sem estourar o disco". */
function encoderArgs(e: Encoder): string[] {
  switch (e) {
    case "libx264":
      // `veryfast`: gravação é tempo real — preset lento faria o encoder ficar
      // pra trás da tela e derrubar quadro.
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-global_quality", "23"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"];
  }
}

/**
 * Monta a linha de comando completa da gravação.
 *
 * Layout dos índices de entrada (importa pro `-map`): tela = 0, câmera = 1 (se
 * houver), microfone = a próxima livre.
 */
export function buildRecordArgs(s: RecordSpec): string[] {
  const args: string[] = [];
  const screen = screenInput(s);
  args.push(...screen.args);

  let next = 1;
  const camIdx = s.camera ? next++ : -1;
  const micIdx = s.mic ? next++ : -1;

  if (s.camera) {
    if (s.platform === "windows") {
      // `-rtbufsize`: sem isso o dshow enche o buffer e derruba quadro
      // ("real-time buffer full") em máquina ocupada — que é o caso normal
      // de quem está gravando um tutorial.
      args.push("-rtbufsize", "128M", "-f", "dshow", "-i", `video=${s.camera.id}`);
    } else {
      args.push("-f", "v4l2", "-i", s.camera.id);
    }
  }
  if (s.mic) {
    if (s.platform === "windows") {
      args.push("-rtbufsize", "128M", "-f", "dshow", "-i", `audio=${s.mic}`);
    } else {
      args.push("-f", "pulse", "-i", s.mic);
    }
  }

  // Grafo de filtros. Sempre nomeado [v] + `-map [v]` pra sair igual nos dois
  // casos (com e sem câmera) — menos caminho pra dar errado.
  const scr = screen.chain ? `[0:v]${screen.chain}[scr]` : `[0:v]null[scr]`;
  let graph: string;
  if (s.camera) {
    const pct = (Math.min(60, Math.max(5, s.camera.sizePct)) / 100).toFixed(4);
    // `scale2ref` escala a câmera tomando a TELA como referência: dentro das
    // expressões, `iw` é a largura da REFERÊNCIA (verificado no ffmpeg real,
    // não é o que o nome sugere), então `iw*0.25` = 25% da tela. `ow/mdar`
    // deriva a altura do aspecto ORIGINAL da câmera — sem isso a webcam
    // esticaria pro aspecto da tela.
    graph =
      `${scr};[${camIdx}:v][scr]scale2ref=w=iw*${pct}:h=ow/mdar[cam][scr2];` +
      `[scr2][cam]overlay=${overlayXY(s.camera.corner)},format=yuv420p[v]`;
  } else {
    graph = `${scr};[scr]format=yuv420p[v]`;
  }
  args.push("-filter_complex", graph, "-map", "[v]");

  if (micIdx >= 0) {
    args.push("-map", `${micIdx}:a`, "-c:a", "aac", "-b:a", "160k");
  }

  args.push(...encoderArgs(s.encoder));
  // Matroska explícito: o contêiner da gravação é MKV porque ele sobrevive a
  // queda de luz/crash (cada cluster se basta). O MP4 só nasce no remux do fim.
  args.push("-f", "matroska", s.outPath);
  return args;
}

/** Um quadro da tela em JPEG no stdout, pro palco da prévia.
 *  `framerate=1` porque queremos UM quadro: pedir 30 fps pra jogar 29 fora só
 *  faria a captura demorar mais pra entregar o primeiro. */
export function buildThumbArgs(grabber: Grabber): string[] {
  const src =
    grabber === "ddagrab"
      ? ["-f", "lavfi", "-i", "ddagrab=output_idx=0:framerate=1"]
      : grabber === "gdigrab"
        ? ["-f", "gdigrab", "-framerate", "1", "-i", "desktop"]
        : ["-f", "x11grab", "-framerate", "1", "-i", ":0.0"];
  const chain = grabber === "ddagrab" ? "hwdownload,format=bgra," : "";
  // `-f mjpeg -` = JPEG cru no stdout: sem arquivo temporário pra limpar depois.
  return [...src, "-frames:v", "1", "-vf", `${chain}scale=960:-2`, "-f", "mjpeg", "-"];
}

/**
 * Remux MKV → MP4 no fim da gravação: `-c copy`, SEM re-encode (instantâneo).
 *
 * `+faststart` põe o índice na frente pro arquivo abrir na hora em player/web.
 */
export function buildRemuxArgs(mkvPath: string, mp4Path: string): string[] {
  return ["-i", mkvPath, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", mp4Path];
}

/** Nome do arquivo a partir do padrão do usuário. Tokens: {date} {time}.
 *  Sem token nenhum, o nome repetiria a cada gravação — quem resolve colisão é
 *  o `unique_path` do Rust, então aqui não precisa inventar sufixo. */
export function expandPattern(pattern: string, now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  const name = pattern.split("{date}").join(date).split("{time}").join(time).trim();
  // Caracteres proibidos em nome de arquivo no Windows viram "-" (o usuário
  // digita o padrão à mão; um ":" aqui quebraria a gravação inteira no fim).
  // Espaco: legal em nome de arquivo, fica. So o que o Windows recusa sai.
  const safe = name.replace(/[<>:"/\|?*]/g, "-");
  return safe.length > 0 ? safe : "gravacao";
}
