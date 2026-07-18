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

/** O áudio do sistema NÃO é uma entrada de dispositivo do ffmpeg: é PCM cru que
 *  o Rust captura por WASAPI loopback e despeja num named pipe (ver
 *  `src-tauri/src/sysaudio.rs`). Aqui só entra o endereço do cano e o formato.
 *
 *  Os três campos vêm do `sys_audio_start` — inclusive o formato, que é o do
 *  dispositivo (não escolha nossa): quem manda no mix format é a placa. */
export interface SysAudioSpec {
  /** `\\.\pipe\localrecord-sysaudio-<pid>` — quem cria e alimenta é o Rust. */
  pipePath: string;
  sampleRate: number;
  channels: number;
}

/** `mixed` = mic e sistema numa faixa só (o padrão do plano: "saída padrão =
 *  composto"). `separate` = uma faixa pra cada, pra ajustar o volume de cada
 *  fonte na edição ("modo produção"). Só faz sentido com as DUAS fontes ligadas. */
export type AudioTracks = "mixed" | "separate";

export interface RecordSpec {
  platform: Platform;
  grabber: Grabber;
  fps: number;
  camera: CameraSpec | null;
  /** Id do microfone, ou null pra gravar sem mic. */
  mic: string | null;
  /** Áudio do sistema, ou null pra não gravar o que o computador toca. */
  sysAudio: SysAudioSpec | null;
  audioTracks: AudioTracks;
  encoder: Encoder;
  /** Arquivo de saída — sempre .mkv (recuperável se faltar luz). */
  outPath: string;
}

/** Rótulos das faixas no modo separado. Ficam em português mesmo com a UI em
 *  outro idioma: são metadados que vão PRO ARQUIVO e a gravação seria feita em
 *  pt hoje e aberta em en amanhã — nome de faixa que muda com o idioma da UI
 *  viraria biblioteca com dois nomes pra mesma coisa. */
const TRACK_MIC = "Microfone";
const TRACK_SYS = "Áudio do sistema";

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

/** A parte de ÁUDIO do grafo + os `-map` dela.
 *
 *  Uma fonte só não precisa de filtro nenhum (`-map N:a` e pronto) — filtro à
 *  toa é mais um lugar pra dar errado numa gravação ao vivo.
 *
 *  `amix` com `normalize=0` de propósito: o padrão do amix DIVIDE cada entrada
 *  pelo número de entradas, ou seja, ligar o áudio do sistema derrubaria o
 *  volume do microfone pela metade — o usuário culparia o microfone. Com
 *  `normalize=0` cada fonte entra com o volume que tem. */
export function buildAudio(
  micIdx: number,
  sysIdx: number,
  tracks: AudioTracks,
): { chain: string; maps: string[] } {
  const hasMic = micIdx >= 0;
  const hasSys = sysIdx >= 0;
  if (!hasMic && !hasSys) return { chain: "", maps: [] };
  if (hasMic && hasSys) {
    if (tracks === "separate") {
      // Faixas separadas: o editor recebe mic e sistema em trilhas próprias e
      // decide o balanço lá (é o "modo produção" do plano). Os títulos entram
      // pra ninguém precisar adivinhar qual é qual no LocalVideo.
      return {
        chain: "",
        maps: [
          "-map", `${micIdx}:a`,
          "-map", `${sysIdx}:a`,
          "-metadata:s:a:0", `title=${TRACK_MIC}`,
          "-metadata:s:a:1", `title=${TRACK_SYS}`,
        ],
      };
    }
    return {
      chain: `[${micIdx}:a][${sysIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]`,
      maps: ["-map", "[a]"],
    };
  }
  return { chain: "", maps: ["-map", `${hasMic ? micIdx : sysIdx}:a`] };
}

/**
 * Monta a linha de comando completa da gravação.
 *
 * Layout dos índices de entrada (importa pro `-map`): tela = 0, câmera = 1 (se
 * houver), microfone e áudio do sistema nas próximas livres, nessa ordem.
 */
export function buildRecordArgs(s: RecordSpec): string[] {
  const args: string[] = [];
  const screen = screenInput(s);
  args.push(...screen.args);

  let next = 1;
  const camIdx = s.camera ? next++ : -1;
  const micIdx = s.mic ? next++ : -1;
  const sysIdx = s.sysAudio ? next++ : -1;

  if (s.camera) {
    if (s.platform === "windows") {
      // `-rtbufsize`: sem isso o dshow enche o buffer e derruba quadro
      // ("real-time buffer full") em máquina ocupada — que é o caso normal
      // de quem está gravando um tutorial.
      //
      // `-framerate` ANTES do `-i`: sem ele o dshow escolhe um modo sozinho, e
      // câmera que oferece 30 e 10 fps pode entregar os 10 — a gravação inteira
      // fica presa no ritmo da webcam. Pedir o mesmo fps da tela mantém as duas
      // entradas no mesmo compasso.
      args.push("-rtbufsize", "128M", "-f", "dshow", "-framerate", String(s.fps), "-i", `video=${s.camera.id}`);
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
  if (s.sysAudio) {
    // PCM cru do WASAPI loopback chegando por um named pipe. Detalhes que
    // importam:
    //  - o formato NÃO é escolha nossa: é o mix format do dispositivo, e o
    //    Rust informa qual é (reamostrar aqui seria inventar trabalho e erro);
    //  - `-thread_queue_size`: o cano é alimentado em tempo real; fila curta
    //    faz o ffmpeg reclamar de "thread message queue blocking" e engasgar;
    //  - isto NÃO é `pipe:`/stdin. O stdin do ffmpeg é do `q` do stop gracioso
    //    (record.rs) — ocupá-lo com áudio custaria o trailer de todo take.
    args.push(
      "-f", "s16le",
      "-ar", String(s.sysAudio.sampleRate),
      "-ac", String(s.sysAudio.channels),
      "-thread_queue_size", "1024",
      "-i", s.sysAudio.pipePath,
    );
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
  const audio = buildAudio(micIdx, sysIdx, s.audioTracks);
  // O grafo é UMA string só: o áudio entra no mesmo `-filter_complex` do vídeo.
  args.push("-filter_complex", audio.chain ? `${graph};${audio.chain}` : graph, "-map", "[v]");

  if (audio.maps.length > 0) {
    args.push(...audio.maps, "-c:a", "aac", "-b:a", "160k");
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
