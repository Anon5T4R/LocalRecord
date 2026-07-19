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
  /** Id do microfone, ou null pra gravar sem mic. No Linux é o que vai pro
   *  `-f pulse`; no Windows é só rótulo, porque quem captura é o `micAudio`. */
  mic: string | null;
  /** No Windows o microfone entra por WASAPI + cano, igual ao áudio do sistema.
   *  `null` = sem microfone, ou Linux (lá o `-f pulse` do ffmpeg é direto e não
   *  tem o problema do dshow). */
  micAudio?: SysAudioSpec | null;
  /** Áudio do sistema, ou null pra não gravar o que o computador toca. */
  sysAudio: SysAudioSpec | null;
  audioTracks: AudioTracks;
  /** Filtro de ruído do MICROFONE (passa-alta + afftdn). Opcional e desligado
   *  por padrão: filtro custa um pouco de voz, e isso é escolha do usuário. */
  micFilter?: boolean;
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

/** Cadeia da opção "Filtrar ruído do microfone": passa-alta em 80 Hz tira o
 *  rumble de mesa/manuseio abaixo da voz, e o `afftdn` reduz chiado CONSTANTE
 *  (ventoinha, ar-condicionado). Valores comedidos de propósito — nr alto come
 *  sibilância da fala. SÓ no microfone: filtrar o áudio do sistema mexeria na
 *  música/vídeo que o usuário está gravando de propósito. */
const MIC_FILTER = "highpass=f=80,afftdn=nr=12:nf=-28";

/** Margem da câmera até a borda, em pixels do vídeo final. */
const MARGIN = 16;

/** Onde a câmera fica na tela, em pixels — a mesma conta que o `overlay` do
 *  ffmpeg fazia até a v0.6.3, agora usada pra posicionar o `<video>` na janela
 *  de anotação (que é quem desenha a câmera desde a v0.7.0).
 *
 *  Continua função PURA e testada pelo mesmo motivo de antes: é a diferença
 *  entre a câmera no canto certo e a câmera cortada pela borda, e "abrir o app e
 *  ver" não garante isso a cada mudança. */
export function cameraBox(
  corner: Corner,
  sizePct: number,
  screenW: number,
  screenH: number,
  aspect: number,
): { left: number; top: number; width: number; height: number } {
  const width = Math.round((screenW * Math.min(60, Math.max(5, sizePct))) / 100);
  // A altura sai do aspecto REAL da câmera; derivar da tela esticaria a imagem.
  const height = Math.round(width / (aspect > 0 ? aspect : 16 / 9));
  const left = corner === "tl" || corner === "bl" ? MARGIN : screenW - width - MARGIN;
  const top = corner === "tl" || corner === "tr" ? MARGIN : screenH - height - MARGIN;
  return { left, top, width, height };
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
  micFilter = false,
): { chain: string; maps: string[] } {
  const hasMic = micIdx >= 0;
  const hasSys = sysIdx >= 0;
  if (!hasMic && !hasSys) return { chain: "", maps: [] };
  // Com filtro, a saída do mic deixa de ser a entrada crua `N:a` e vira o
  // rótulo `[mf]` do grafo — o resto da cadeia lê DALI, seja o amix, seja o
  // `-map` direto. Sem filtro, nada muda: filtro à toa é lugar pra dar errado.
  const mf = hasMic && micFilter ? `[${micIdx}:a]${MIC_FILTER}[mf]` : "";
  const micOut = mf ? "[mf]" : `${micIdx}:a`;
  if (hasMic && hasSys) {
    if (tracks === "separate") {
      // Faixas separadas: o editor recebe mic e sistema em trilhas próprias e
      // decide o balanço lá (é o "modo produção" do plano). Os títulos entram
      // pra ninguém precisar adivinhar qual é qual no LocalVideo. O filtro (se
      // ligado) age só na trilha do mic — a do sistema segue como veio.
      return {
        chain: mf,
        maps: [
          "-map", micOut,
          "-map", `${sysIdx}:a`,
          "-metadata:s:a:0", `title=${TRACK_MIC}`,
          "-metadata:s:a:1", `title=${TRACK_SYS}`,
        ],
      };
    }
    // No mixed o filtro entra ANTES do amix: filtrar a mixagem pronta atacaria
    // também o áudio do sistema, que é justamente o que não se filtra.
    const amixIn = mf ? "[mf]" : `[${micIdx}:a]`;
    const amix = `${amixIn}[${sysIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]`;
    return {
      chain: mf ? `${mf};${amix}` : amix,
      maps: ["-map", "[a]"],
    };
  }
  if (hasMic) return { chain: mf, maps: ["-map", micOut] };
  return { chain: "", maps: ["-map", `${sysIdx}:a`] };
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
  const micIdx = s.mic ? next++ : -1;
  const sysIdx = s.sysAudio ? next++ : -1;

  if (s.mic) {
    if (s.platform === "windows") {
      // O microfone entra pelo MESMO caminho do áudio do sistema: PCM cru que o
      // Rust captura por WASAPI e despeja num cano. Ele saía por
      // `-f dshow -i audio=…` e essa entrada derrubava a gravação INTEIRA, vídeo
      // junto — medido na mesma máquina, gravando 10 s a 30 fps (alvo 300):
      //
      //   sem áudio nenhum .................... 298
      //   por cano (s16le) .................... 298
      //   dshow, microfone USB ................ 101
      //   dshow, microfone Realtek ............. 26
      //
      // O sintoma aparecia no fps do VÍDEO, que é o último lugar onde se procura
      // um problema de áudio. Detalhes em `sysaudio.rs` (`mic_pipe_path`).
      //
      // Sem `micAudio` a captura por WASAPI não subiu — e isso ACONTECE: na
      // máquina onde tudo isto foi medido, o `IAudioClient::Initialize` da
      // ENTRADA não responde (o mesmo endpoint que já recusava a saída, ver o
      // topo de `sysaudio.rs`). Ali o dshow é o único caminho que abre o
      // microfone de verdade.
      //
      // Então o dshow continua existindo como plano B, com as mitigações
      // medidas: `-audio_buffer_size 10` levou o mesmo teste de 101 pra 222
      // quadros (de 300). Não é o caminho bom, é o caminho que funciona quando o
      // bom não sobe — gravar SEM microfone seria pior que gravar devagar.
      if (s.micAudio) {
        args.push(
          "-f", "s16le",
          "-ar", String(s.micAudio.sampleRate),
          "-ac", String(s.micAudio.channels),
          "-thread_queue_size", "1024",
          "-i", s.micAudio.pipePath,
        );
      } else {
        args.push(
          "-audio_buffer_size", "10",
          "-thread_queue_size", "1024",
          "-rtbufsize", "128M",
          "-f", "dshow",
          "-i", `audio=${s.mic}`,
        );
      }
    } else {
      // Linux: `-f pulse` direto, sem intermediário. O gargalo medido é do
      // dshow, que não existe aqui.
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
  // A câmera NÃO entra aqui desde a v0.7.0, e isso é o conserto de um gargalo
  // medido, não uma simplificação. Duas capturas ao vivo no MESMO processo
  // ffmpeg se atrapalham: a tela sozinha dá 30 fps, a câmera sozinha dá 30, e as
  // duas juntas caem pra 10 — enquanto a MESMA câmera capturada em outro
  // processo deixa a tela intacta (298 de 300 quadros). Nenhuma opção de
  // framesync, timestamp ou buffer chegou perto de resolver.
  //
  // Agora a câmera é desenhada na janela de anotação, que já fica por cima da
  // tela — e o `ddagrab` a captura junto, de graça, exatamente como já acontece
  // com os riscos da caneta. O ffmpeg volta a ter UMA captura só.
  const graph = screen.chain ? `[0:v]${screen.chain},format=yuv420p[v]` : `[0:v]format=yuv420p[v]`;

  const audio = buildAudio(micIdx, sysIdx, s.audioTracks, !!s.micFilter);
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
export function buildRemuxArgs(mkvPath: string, mp4Path: string, spec?: RecordSpec): string[] {
  // O muxer MP4 DESCARTA o `title` que as faixas trazem do MKV (vira o genérico
  // "SoundHandler") — mas um `handler_name` setado de propósito sobrevive, e é
  // ele que o LocalVideo lê como nome da faixa quando o title não existe.
  const separate = spec?.audioTracks === "separate" && !!spec.micAudio && !!spec.sysAudio;
  const meta = separate
    ? ["-metadata:s:a:0", `handler_name=${TRACK_MIC}`, "-metadata:s:a:1", `handler_name=${TRACK_SYS}`]
    : [];
  return ["-i", mkvPath, "-map", "0", "-c", "copy", ...meta, "-movflags", "+faststart", "-f", "mp4", mp4Path];
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
