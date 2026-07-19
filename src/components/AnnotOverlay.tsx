import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cameraBox, type Corner } from "../lib/args";
import { openCamera } from "../lib/camera";
import {
  BG_BLUR_PX,
  coverRect,
  effectiveCamBg,
  needsSegmentation,
  normalizeCamBg,
  normalizeCamBgImage,
  type CamBg,
} from "../lib/cambg";
import { createSegmenter, type Segmenter } from "../lib/segmenter";
import { SEG_DIM } from "../lib/segtypes";
import {
  COLORS,
  eraseAt,
  shouldAppend,
  WIDTHS,
  type Item,
  type Pt,
  type Tool,
} from "../lib/annot";
import { t } from "../lib/i18n";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface AnnotSnapshot {
  armed: boolean;
  pen: boolean;
}

/** O que a janela principal manda pelo evento `annot-camera`.
 *
 *  Os campos novos são OPCIONAIS de propósito: o payload é o contrato entre
 *  duas janelas que podem estar em versões diferentes durante um HMR, e um
 *  `bg` ausente tem que significar "como sempre foi", não "quebrou". */
interface CamPayload {
  id: string;
  corner: Corner;
  sizePct: number;
  opacity?: number;
  bg?: string;
  bgImage?: string;
}

/** Raio da borracha em px de tela. Generoso de propósito: quem está apagando
 *  está falando com uma turma ao mesmo tempo, não mirando. */
const ERASER_R = 22;

/**
 * O overlay em si: canvas do tamanho da tela + barrinha de ferramentas.
 *
 * O click-through NÃO é decidido aqui — quem manda é o Rust
 * (`set_ignore_cursor_events`, ver `annot.rs`), porque é uma propriedade da
 * JANELA no SO, não do DOM. Este componente só reage ao estado que o Rust
 * anuncia (`annot-state`). O `pointer-events: none` no root quando a caneta
 * está desligada é cinto e suspensório: se o overlay algum dia receber um
 * evento que não deveria, ele não vira risco na tela do usuário.
 */
export default function AnnotOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pen, setPen] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [width, setWidth] = useState<number>(WIDTHS[1]);
  const [items, setItems] = useState<Item[]>([]);
  const [typing, setTyping] = useState<Pt | null>(null);
  const [draft, setDraft] = useState("");
  const [bar, setBar] = useState({ x: 24, y: 24 });
  // A câmera vive AQUI desde a v0.7.0. Ela não passa mais pelo ffmpeg: esta
  // janela já fica por cima da tela, então o `ddagrab` a captura junto — de
  // graça, do mesmo jeito que já captura os riscos da caneta.
  //
  // O motivo é medido: duas capturas ao vivo no mesmo processo ffmpeg derrubam a
  // gravação de 30 pra 10 fps (ver `args.ts`). Aqui o ffmpeg volta a ter uma
  // captura só, e a câmera fica por conta do webview, que já sabia exibi-la.
  const [cam, setCam] = useState<CamPayload | null>(null);
  const [camAspect, setCamAspect] = useState(16 / 9);
  const camRef = useRef<HTMLVideoElement>(null);

  // ---- fundo virtual da câmera (v0.7.7) ------------------------------------
  // O modo que REALMENTE vale: `image` sem imagem carregada é `none` (ver
  // `effectiveCamBg`). Tudo abaixo é no-op enquanto for `none`, e é o default —
  // quem não pediu fundo não paga worker, modelo, canvas nem um quadro de CPU.
  const bg: CamBg = effectiveCamBg(normalizeCamBg(cam?.bg), normalizeCamBgImage(cam?.bgImage));
  /** O canvas que SUBSTITUI o `<video>` na tela quando há fundo. */
  const camCanvasRef = useRef<HTMLCanvasElement>(null);
  const segRef = useRef<Segmenter | null>(null);
  /** A imagem de fundo já decodificada. `undefined` = ainda carregando. */
  const bgBitmapRef = useRef<ImageBitmap | null>(null);
  // Canvases de trabalho, criados uma vez: recriar a cada quadro seria alocar
  // (e descartar) três buffers 30 vezes por segundo.
  const workRef = useRef<{
    /** Entrada do modelo, SEG_DIM². */
    inCv: HTMLCanvasElement;
    inCtx: CanvasRenderingContext2D;
    /** A máscara devolvida pelo worker, pra virar textura componível. */
    maskCv: HTMLCanvasElement;
    maskCtx: CanvasRenderingContext2D;
    /** A pessoa recortada, no tamanho da caixa. */
    perCv: HTMLCanvasElement;
    perCtx: CanvasRenderingContext2D;
  } | null>(null);

  // O traço em curso vive num ref, não no state: um `setState` por evento de
  // mouse (dezenas por segundo) faria a caneta arrastar atrás do cursor.
  const live = useRef<Item | null>(null);
  // A caixinha de texto. Precisa de ref porque o `autoFocus` do React roda na
  // MONTAGEM, e nesse instante a janela do overlay ainda pode não ser a de
  // primeiro plano — quando ela vira, o WebView2 devolve o foco pro documento
  // e o campo fica com o cursor piscando sem receber tecla nenhuma.
  const inputRef = useRef<HTMLInputElement>(null);
  // O `commitText` mais recente, pra rede de segurança do teclado poder chamá-lo
  // sem depender da ordem em que as constantes deste componente são declaradas.
  const commitRef = useRef<(() => void) | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  /** Redesenha tudo. Objetos → pixels acontece só aqui. */
  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // A janela é transparente: limpar o canvas devolve o buraco por onde se vê
    // a tela de verdade. Nada de pintar fundo aqui.
    ctx.clearRect(0, 0, cv.width, cv.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = live.current ? [...items, live.current] : items;
    for (const it of all) {
      if (it.kind === "text") {
        ctx.fillStyle = it.color;
        ctx.font = `600 ${it.size}px system-ui, sans-serif`;
        // Contorno escuro: texto vermelho some num fundo vermelho, e a tela do
        // usuário pode ser qualquer coisa.
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.strokeText(it.text, it.at.x, it.at.y);
        ctx.fillText(it.text, it.at.x, it.at.y);
        continue;
      }
      ctx.strokeStyle = it.color;
      ctx.lineWidth = it.width;
      ctx.beginPath();
      if (it.pts.length === 1) {
        // Um toque sem arrastar tem que virar um ponto visível; `stroke()` num
        // caminho de comprimento zero não desenha nada.
        ctx.arc(it.pts[0].x, it.pts[0].y, it.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = it.color;
        ctx.fill();
      } else {
        ctx.moveTo(it.pts[0].x, it.pts[0].y);
        for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i].x, it.pts[i].y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }, [items]);

  // Canvas em pixels FÍSICOS (dpr): num monitor a 150% um canvas em px lógicos
  // sairia borrado — e o borrado vai pro vídeo junto.
  useEffect(() => {
    const fit = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(window.innerWidth * dpr);
      cv.height = Math.round(window.innerHeight * dpr);
      cv.style.width = `${window.innerWidth}px`;
      cv.style.height = `${window.innerHeight}px`;
      redraw();
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [redraw]);

  useEffect(redraw, [redraw]);

  // A verdade do estado é do Rust (o atalho global pode ligar a caneta sem
  // passar por nenhum clique nesta janela).
  useEffect(() => {
    if (!isTauri) return;
    invoke<AnnotSnapshot>("annot_state").then((s) => setPen(s.pen)).catch(() => {});
    const un = [
      listen<AnnotSnapshot>("annot-state", (e) => setPen(e.payload.pen)),
      listen("annot-clear", () => {
        live.current = null;
        setTyping(null);
        setItems([]);
      }),
    ];
    return () => {
      for (const p of un) void p.then((f) => f());
    };
  }, []);

  // Config da câmera, mandada pela janela principal (mesma origem, evento do
  // Tauri). Chega quando a gravação começa e some quando ela para.
  useEffect(() => {
    if (!isTauri) return;
    const un = listen<CamPayload | null>("annot-camera", (e) => setCam(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // A câmera ao vivo. Mesmo cuidado do preview da janela principal: soltar o
  // aparelho quando ele não é mais necessário, senão a webcam fica acesa sem
  // ninguém olhando — e um aparelho com dois donos não funciona pra ninguém.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    if (!cam?.id) {
      if (camRef.current) camRef.current.srcObject = null;
      return;
    }
    // `openCamera` e NÃO `getUserMedia` direto: o id que o app carrega é o nome
    // do dshow, e o navegador quer um `deviceId` que é outro identificador. Não
    // há id comum entre os dois mundos — o casamento é por rótulo. Passar o nome
    // cru aqui foi o que fez a v0.7.0 gravar uma caixa vazia no lugar da câmera.
    openCamera(cam.id)
      .then((s) => {
        if (!alive) {
          for (const tr of s.getTracks()) tr.stop();
          return;
        }
        stream = s;
        if (camRef.current) camRef.current.srcObject = s;
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (stream) for (const tr of stream.getTracks()) tr.stop();
    };
  }, [cam?.id]);

  // O worker de segmentação vive enquanto houver fundo pedido. Sobe e desce com
  // a NECESSIDADE, não com a gravação: trocar de desfoque pra imagem não
  // recarrega o modelo (são 462 KB e ~250 ms de sessão), mas voltar pra
  // "nenhum" mata o worker de verdade — deixá-lo vivo seria manter um núcleo
  // ocupado pra nada durante o resto do take.
  const wantSeg = needsSegmentation(bg);
  useEffect(() => {
    if (!wantSeg) return;
    const seg = createSegmenter();
    segRef.current = seg;
    return () => {
      segRef.current = null;
      seg.dispose();
    };
  }, [wantSeg]);

  // Canvases de trabalho: uma vez só, na primeira vez que houver fundo.
  useEffect(() => {
    if (!wantSeg || workRef.current) return;
    const mk = (w: number, h: number, readback = false) => {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      // `willReadFrequently` só no canvas de onde se LÊ: sem a dica o Chromium
      // mantém o buffer na GPU e cada `getImageData` vira um round-trip.
      const ctx = cv.getContext("2d", readback ? { willReadFrequently: true } : undefined)!;
      return { cv, ctx };
    };
    const a = mk(SEG_DIM, SEG_DIM, true);
    const b = mk(SEG_DIM, SEG_DIM);
    const c = mk(16, 16); // redimensionado no primeiro quadro, ver compose
    workRef.current = {
      inCv: a.cv,
      inCtx: a.ctx,
      maskCv: b.cv,
      maskCtx: b.ctx,
      perCv: c.cv,
      perCtx: c.ctx,
    };
  }, [wantSeg]);

  // A imagem de fundo, decodificada uma vez por escolha (e não por quadro).
  // `createImageBitmap` e não `<img>`: o bitmap já vem pronto pro canvas, sem
  // decodificação escondida no meio do laço de composição.
  const bgImage = bg === "image" ? normalizeCamBgImage(cam?.bgImage) : "";
  useEffect(() => {
    let alive = true;
    if (!bgImage) {
      bgBitmapRef.current?.close();
      bgBitmapRef.current = null;
      return;
    }
    fetch(bgImage)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        if (!alive) {
          bmp.close();
          return;
        }
        bgBitmapRef.current?.close();
        bgBitmapRef.current = bmp;
      })
      // Data URL corrompido: fica sem bitmap e a composição desenha a câmera
      // crua (ver compose) — nunca um buraco preto no take.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bgImage]);

  // O LAÇO DE COMPOSIÇÃO. Roda só quando há fundo; com "nenhum" o `<video>`
  // volta a desenhar sozinho e este efeito nem monta.
  //
  // rAF e não `requestVideoFrameCallback`: o vídeo fica `display:none` quando o
  // canvas assume (senão apareceriam os dois), e rVFC depende de o elemento
  // APRESENTAR quadro. O rAF é do documento — esta janela está visível na tela
  // (é ela que o ddagrab filma), então ele bate no ritmo do monitor.
  useEffect(() => {
    if (!wantSeg || !cam) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const video = camRef.current;
      const cv = camCanvasRef.current;
      const work = workRef.current;
      if (!video || !cv || !work || video.readyState < 2 || video.videoWidth === 0) return;

      const box = cameraBox(cam.corner, cam.sizePct, window.innerWidth, window.innerHeight, camAspect);
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.max(1, Math.round(box.width * dpr));
      const ph = Math.max(1, Math.round(box.height * dpr));
      // Canvas em pixels FÍSICOS: mesma regra do canvas dos riscos — num
      // monitor a 150% o borrado iria pro vídeo junto.
      if (cv.width !== pw || cv.height !== ph) {
        cv.width = pw;
        cv.height = ph;
      }
      if (work.perCv.width !== pw || work.perCv.height !== ph) {
        work.perCv.width = pw;
        work.perCv.height = ph;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;

      // 1. Alimenta o worker. Ele descarta o quadro se estiver ocupado — é o
      //    que mantém o custo elástico (ver `segmenter.ts`).
      work.inCtx.drawImage(video, 0, 0, SEG_DIM, SEG_DIM);
      segRef.current?.push(work.inCtx.getImageData(0, 0, SEG_DIM, SEG_DIM).data);

      const mask = segRef.current?.mask() ?? null;
      if (!mask) {
        // Ainda sem máscara (primeiros ~300 ms, ou o modelo não carregou):
        // desenha a câmera crua. É exatamente o que o usuário veria sem a
        // feature — degradar pro comportamento de sempre, nunca pra tela preta.
        ctx.clearRect(0, 0, pw, ph);
        ctx.drawImage(video, 0, 0, pw, ph);
        return;
      }
      work.maskCtx.putImageData(mask, 0, 0);

      // 2. O FUNDO.
      ctx.clearRect(0, 0, pw, ph);
      const bmp = bgBitmapRef.current;
      if (bg === "image" && bmp) {
        // `coverRect` e não um drawImage esticado: a foto do usuário tem o
        // aspecto dela e a caixa tem o da webcam.
        const r = coverRect(bmp.width, bmp.height, pw, ph);
        ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, pw, ph);
      } else {
        // Desfoque de VERDADE: borra uma cópia do quadro e depois cola a pessoa
        // NÍTIDA por cima. Um `filter: blur()` no `<video>` inteiro borraria a
        // pessoa junto — isso não é fundo desfocado, é câmera fora de foco.
        ctx.filter = `blur(${BG_BLUR_PX * dpr}px)`;
        ctx.drawImage(video, 0, 0, pw, ph);
        ctx.filter = "none";
      }

      // 3. A PESSOA, recortada pela máscara e colada por cima.
      work.perCtx.globalCompositeOperation = "source-over";
      work.perCtx.clearRect(0, 0, pw, ph);
      work.perCtx.drawImage(video, 0, 0, pw, ph);
      // `destination-in` = mantém só onde a máscara tem alpha. A máscara sobe de
      // 256² pro tamanho da caixa com a suavização do próprio drawImage, que é
      // o que dá a borda macia de graça.
      work.perCtx.globalCompositeOperation = "destination-in";
      work.perCtx.drawImage(work.maskCv, 0, 0, pw, ph);
      work.perCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(work.perCv, 0, 0);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wantSeg, cam, camAspect, bg]);

  // Rede de segurança do teclado. Com a caixinha aberta, tecla que chegue na
  // JANELA e não no campo ainda entra no texto.
  //
  // Existe porque o foco desta janela é um problema real e recorrente: ela nasce
  // `focus: false`, é transparente, sem decoração e always-on-top, e o WebView2
  // devolve o foco pro documento quando a janela vira primeiro plano. Foram
  // quatro tentativas mirando em fazer o `<input>` receber foco; esta para de
  // depender disso. Se o webview receber a tecla, o texto funciona.
  //
  // Só age quando o campo NÃO está com o foco — senão cada tecla entraria duas
  // vezes.
  useEffect(() => {
    if (!typing) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement === inputRef.current) return;
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        // O commit real mora no handler do campo; aqui só se reproduz o efeito.
        if (e.key === "Escape") {
          setTyping(null);
          setDraft("");
        } else {
          setDraft((d) => {
            queueMicrotask(() => commitRef.current?.());
            return d;
          });
        }
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
        return;
      }
      // Só caractere de verdade: teclas de função e modificadores têm `key` com
      // mais de um caractere e não podem virar texto na tela do usuário.
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setDraft((d) => d + e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [typing]);

  const at = (e: React.PointerEvent): Pt => ({ x: e.clientX, y: e.clientY });

  const onDown = (e: React.PointerEvent) => {
    if (!pen) return;
    const p = at(e);
    if (tool === "text") {
      // Clicar em outro lugar com uma caixinha aberta COMITA o que estava nela.
      // É o que o `onBlur` fazia — e o `onBlur` era justamente o problema.
      if (typing) commitText();
      setTyping(p);
      setDraft("");
      // A janela do overlay nasce `focus: false` (tauri.conf.json) e no Windows
      // o clique não a traz pro primeiro plano — sem este pedido as teclas vão
      // pro aplicativo de baixo. Só aqui, não ao ligar a caneta: quem apenas
      // rabisca continua sem perder o foco do que estava fazendo.
      //
      // A ORDEM importa e foi o que derrubou a primeira tentativa (v0.4.0):
      // pedir o foco e seguir em frente não basta. O `set_focus` do Tauri é uma
      // mensagem pro laço de eventos, então a janela vira primeiro plano DEPOIS
      // do input já ter montado — e aí o WebView2 põe o foco no documento. Por
      // isso o campo é focado de novo QUANDO o pedido volta.
      if (isTauri) {
        void invoke("annot_focus")
          .then(() => inputRef.current?.focus())
          .catch(() => {});
      }
      return;
    }
    // O `?.` não basta: com pointer não-ativo (evento sintético, caneta em
    // transição) o setPointerCapture LANÇA NotFoundError e mataria o gesto.
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* sem captura: o traço segue, só perde o "seguir fora da janela" */
    }
    if (tool === "eraser") {
      setItems((cur) => eraseAt(cur, p, ERASER_R));
      return;
    }
    live.current = { kind: "stroke", pts: [p], color, width };
    redraw();
  };

  const onMove = (e: React.PointerEvent) => {
    if (!pen) return;
    const p = at(e);
    if (tool === "eraser") {
      // `buttons` e não `pressed`: a borracha só apaga arrastando com o botão
      // apertado — passar o mouse por cima não pode comer a aula.
      if (e.buttons & 1) setItems((cur) => eraseAt(cur, p, ERASER_R));
      return;
    }
    const s = live.current;
    if (!s || s.kind !== "stroke") return;
    if (!shouldAppend(s.pts, p)) return;
    s.pts.push(p);
    redraw();
  };

  const onUp = () => {
    const s = live.current;
    if (!s) return;
    live.current = null;
    setItems((cur) => [...cur, s]);
  };

  const commitText = () => {
    const p = typing;
    setTyping(null);
    if (!p || !draft.trim()) return;
    setItems((cur) => [...cur, { kind: "text", at: p, text: draft, color, size: Math.max(16, width * 4) }]);
    setDraft("");
  };

  commitRef.current = commitText;

  const penOff = () => void invoke("annot_set_pen", { on: false }).catch(() => {});
  const clearAll = () => {
    live.current = null;
    setTyping(null);
    setItems([]);
  };

  // Arrastar a barrinha: ela FICA no vídeo enquanto a caneta está ligada, então
  // o usuário precisa poder tirá-la da frente do que está explicando.
  const barDown = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - bar.x, dy: e.clientY - bar.y };
    // Blindada: NotFoundError com pointer não-ativo mataria o arrasto (o `?.`
    // só cobre método ausente, não a exceção).
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* segue sem captura */
    }
  };
  const barMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setBar({
      x: Math.min(Math.max(0, e.clientX - d.dx), window.innerWidth - 60),
      y: Math.min(Math.max(0, e.clientY - d.dy), window.innerHeight - 40),
    });
  };
  const barUp = () => {
    drag.current = null;
  };

  return (
    <div className={`annot-root${pen ? " pen" : ""}`}>
      <canvas
        ref={canvasRef}
        className="annot-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />

      {/* Com fundo virtual, o `<video>` vira só a FONTE: some da tela
          (`display:none`) e quem aparece é o canvas composto logo abaixo. Ele
          continua tocando — é `MediaStream` ao vivo, não depende de estar
          visível pra decodificar — e o rAF do laço puxa o quadro atual dele. */}
      {cam && (
        <video
          ref={camRef}
          className="annot-cam"
          autoPlay
          playsInline
          muted
          // O áudio do microfone é gravado pelo Rust (WASAPI); deixar este
          // elemento com som devolveria o próprio áudio pelos alto-falantes.
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth > 0 && v.videoHeight > 0) setCamAspect(v.videoWidth / v.videoHeight);
          }}
          style={{
            ...cameraBox(
              cam.corner,
              cam.sizePct,
              window.innerWidth,
              window.innerHeight,
              camAspect,
            ),
            // `opacity` no ELEMENTO, de propósito: a `.annot-cam` tem canto
            // arredondado e sombra, e opacity no elemento leva a moldura junto.
            // É o que se quer — câmera meio transparente com sombra opaca por
            // baixo pareceria um retângulo sujo grudado na tela, e a sombra é
            // justamente a parte que mais chama atenção no que se quer discreto.
            // Sem valor no payload = opaco: o default nunca muda o take de quem
            // não mexeu no controle.
            opacity: (cam.opacity ?? 100) / 100,
            ...(bg === "none" ? null : { display: "none" }),
          }}
        />
      )}

      {/* O canvas herda a MESMA `.annot-cam` (canto arredondado + sombra) e a
          mesma caixa: quem olha o take não distingue "câmera" de "câmera com
          fundo", só o fundo muda. A opacidade continua no ELEMENTO pelo motivo
          da v0.7.6 — sombra opaca por baixo de imagem translúcida pareceria um
          retângulo sujo grudado na tela. */}
      {cam && bg !== "none" && (
        <canvas
          ref={camCanvasRef}
          className="annot-cam"
          style={{
            ...cameraBox(cam.corner, cam.sizePct, window.innerWidth, window.innerHeight, camAspect),
            opacity: (cam.opacity ?? 100) / 100,
          }}
        />
      )}

      {typing && (
        <input
          ref={inputRef}
          className="annot-text-input"
          style={{ left: typing.x, top: typing.y - 28, color }}
          autoFocus
          value={draft}
          placeholder={t("annot.textPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText();
            // Esc desiste do texto sem comitar — a tecla que todo mundo tenta.
            if (e.key === "Escape") {
              setTyping(null);
              setDraft("");
            }
          }}
        />
      )}

      {/* A barra só existe com a caneta na mão: com a caneta desligada ela
          seria só um adesivo queimado no vídeo do usuário o take inteiro. */}
      {pen && (
        <div className="annot-bar" style={{ left: bar.x, top: bar.y }}>
          <div
            className="annot-grip"
            title={t("annot.drag")}
            onPointerDown={barDown}
            onPointerMove={barMove}
            onPointerUp={barUp}
          >
            ⠿
          </div>

          <button className={tool === "pen" ? "on" : ""} title={t("annot.pen")} onClick={() => setTool("pen")}>
            ✎
          </button>
          <button className={tool === "text" ? "on" : ""} title={t("annot.text")} onClick={() => setTool("text")}>
            T
          </button>
          <button
            className={tool === "eraser" ? "on" : ""}
            title={t("annot.eraser")}
            onClick={() => setTool("eraser")}
          >
            ⌫
          </button>

          <span className="annot-sep" />

          {COLORS.map((c) => (
            <button
              key={c}
              className={`annot-color${c === color ? " on" : ""}`}
              style={{ background: c }}
              title={t("annot.color")}
              onClick={() => {
                setColor(c);
                // Escolher cor é gesto de quem quer DESENHAR: a borracha não
                // tem cor, ficar nela seria só uma pegadinha.
                if (tool === "eraser") setTool("pen");
              }}
            />
          ))}

          <span className="annot-sep" />

          {WIDTHS.map((w) => (
            <button
              key={w}
              className={`annot-w${w === width ? " on" : ""}`}
              title={t("annot.width")}
              onClick={() => setWidth(w)}
            >
              <span style={{ width: w + 2, height: w + 2 }} />
            </button>
          ))}

          <span className="annot-sep" />

          <button title={t("annot.clear")} onClick={clearAll}>
            🗑
          </button>
          <button className="annot-off" title={t("annot.penOff")} onClick={penOff}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
