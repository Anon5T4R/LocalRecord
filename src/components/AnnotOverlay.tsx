import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cameraBox, type Corner } from "../lib/args";
import { openCamera } from "../lib/camera";
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
  const [cam, setCam] = useState<{ id: string; corner: Corner; sizePct: number } | null>(null);
  const [camAspect, setCamAspect] = useState(16 / 9);
  const camRef = useRef<HTMLVideoElement>(null);

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
    const un = listen<{ id: string; corner: Corner; sizePct: number } | null>(
      "annot-camera",
      (e) => setCam(e.payload),
    );
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
    (e.target as Element).setPointerCapture?.(e.pointerId);
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
    (e.target as Element).setPointerCapture?.(e.pointerId);
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
          style={cameraBox(
            cam.corner,
            cam.sizePct,
            window.innerWidth,
            window.innerHeight,
            camAspect,
          )}
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
