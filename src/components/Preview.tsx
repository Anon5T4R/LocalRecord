import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openCamera } from "../lib/camera";
import { buildThumbArgs, type Corner, type Grabber } from "../lib/args";
import { t } from "../lib/i18n";

/**
 * Palco WYSIWYG: o usuário arruma a câmera ANTES de gravar e o que ele monta
 * aqui vira parâmetro do `filter_complex` (canto + tamanho). Por isso o palco
 * tem o aspecto da tela real e a câmera é medida em % da LARGURA — as mesmas
 * duas grandezas que o `buildRecordArgs` consome. Se o palco mentisse, o vídeo
 * sairia diferente da prévia, que é o pecado capital de um estúdio de captura.
 */

/** Margem da câmera à borda, em px do VÍDEO — igual à do overlay em args.ts. */
const MARGIN_PX = 16;

interface Props {
  grabber: Grabber;
  /** Id do dispositivo escolhido, ou "" pra nenhuma câmera. */
  cameraId: string;
  corner: Corner;
  sizePct: number;
  onCornerChange: (c: Corner) => void;
  /** Trava os controles enquanto grava (mudar layout no meio não tem efeito:
   *  o grafo do ffmpeg já está montado). */
  disabled: boolean;
}


export default function Preview(props: Props) {
  const { grabber, cameraId, corner, sizePct, onCornerChange, disabled } = props;
  const [thumb, setThumb] = useState<string>("");
  const [camError, setCamError] = useState("");
  /** Por que o quadro da tela não veio. Vazio = não houve erro. */
  const [shotErr, setShotErr] = useState("");
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Aspecto do palco = o da tela de verdade, senão a prévia mente sobre o
  // enquadramento.
  const screenW = typeof window !== "undefined" ? window.screen.width : 1920;
  const screenH = typeof window !== "undefined" ? window.screen.height : 1080;

  // Um quadro da tela como fundo. Falha aqui não é fatal: o palco continua
  // servindo pra posicionar a câmera, só fica sem a foto atrás.
  //
  // Duas coisas que a v0.3 errava e que a `disabled` na lista de dependências
  // conserta de uma vez:
  //
  //  1. **Buscava uma vez só.** A DDA falha de vez em quando (foi o que o
  //     "Sem prévia da tela" dos testes reais mostrou); sem nova tentativa, o
  //     palco ficava preto pra sempre naquela sessão. Agora, ao voltar pro
  //     estado parado, tenta de novo.
  //  2. **Não sabia da gravação.** Buscar o quadro com a gravação em pé abriria
  //     uma SEGUNDA sessão de Desktop Duplication disputando com o `ddagrab` do
  //     ffmpeg — o mesmo tipo de disputa que estragou os takes pela webcam.
  useEffect(() => {
    let url = "";
    let alive = true;
    // A limpeza da rodada anterior já revogou a URL do blob; deixar o `img`
    // apontando pra ela renderizaria um ícone de imagem quebrada.
    if (disabled) {
      setThumb("");
      return;
    }
    setShotErr("");
    invoke<number[]>("rec_screen_thumb", { args: buildThumbArgs(grabber) })
      .then((bytes) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
        setThumb(url);
      })
      .catch((e) => {
        // O erro era ENGOLIDO aqui, e o palco só dizia "sem prévia da tela" —
        // uma mensagem que serve pra qualquer causa e por isso não serve pra
        // nenhuma. Foi o que manteve este bug (B6) sem diagnóstico por várias
        // rodadas: o mesmo comando roda perfeitamente pela linha de comando.
        if (!alive) return;
        setThumb("");
        setShotErr(String(e));
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [grabber, disabled]);

  // Câmera ao vivo no palco — SÓ enquanto parado.
  //
  // Soltar a webcam ao gravar continua obrigatório, mas o motivo MUDOU na
  // v0.7.0: não é mais o ffmpeg que a quer — é a janela de anotação, que passou
  // a desenhar a câmera (o ffmpeg não a captura mais; ver `args.ts`). O aparelho
  // segue tendo um dono por vez, só que agora o outro dono é outra janela nossa.
  //
  // O mesmo motivo do medidor de microfone sumir durante a gravação (App.tsx).
  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    setCamError("");
    if (!cameraId || disabled) {
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }
    openCamera(cameraId)
      .then((s) => {
        // Desmontou/trocou de câmera enquanto abria: soltar, senão a webcam
        // fica acesa sem ninguém olhando.
        if (!alive) {
          for (const tr of s.getTracks()) tr.stop();
          return;
        }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => alive && setCamError(String(e)));
    return () => {
      alive = false;
      if (stream) for (const tr of stream.getTracks()) tr.stop();
    };
  }, [cameraId, disabled]);

  /** Solta o arraste no canto mais perto — os cantos são o vocabulário do
   *  overlay, então o arraste livre sempre "cai" num deles. */
  const drop = useCallback(
    (clientX: number, clientY: number) => {
      const box = stageRef.current?.getBoundingClientRect();
      setDragging(null);
      if (!box) return;
      const right = clientX - box.left > box.width / 2;
      const bottom = clientY - box.top > box.height / 2;
      onCornerChange(((bottom ? "b" : "t") + (right ? "r" : "l")) as Corner);
    },
    [onCornerChange],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setDragging({ x: e.clientX, y: e.clientY });
    const up = (e: PointerEvent) => drop(e.clientX, e.clientY);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, drop]);

  // Posição em repouso: a mesma conta do overlay, só que em % do palco — é o
  // que faz a prévia e o vídeo baterem.
  const marginPct = (MARGIN_PX / screenW) * 100;
  const marginPctY = (MARGIN_PX / screenH) * 100;
  const camStyle: React.CSSProperties = { width: `${sizePct}%` };
  if (dragging && stageRef.current) {
    const box = stageRef.current.getBoundingClientRect();
    camStyle.left = `${((dragging.x - box.left) / box.width) * 100}%`;
    camStyle.top = `${((dragging.y - box.top) / box.height) * 100}%`;
    camStyle.transform = "translate(-50%, -50%)";
  } else {
    if (corner === "tl" || corner === "bl") camStyle.left = `${marginPct}%`;
    else camStyle.right = `${marginPct}%`;
    if (corner === "tl" || corner === "tr") camStyle.top = `${marginPctY}%`;
    else camStyle.bottom = `${marginPctY}%`;
  }

  return (
    <div className="card">
      <div className="card-head">
        <strong>{t("preview.title")}</strong>
        <span className="muted small">
          {screenW}×{screenH}
        </span>
      </div>

      <div
        className="stage"
        ref={stageRef}
        style={{ aspectRatio: `${screenW} / ${screenH}` }}
      >
        {thumb ? (
          <img className="stage-shot" src={thumb} alt="" draggable={false} />
        ) : (
          <div className="stage-empty">
            <span className="muted small">{t("preview.noShot")}</span>
            {shotErr && <span className="muted small stage-empty-why">{shotErr}</span>}
          </div>
        )}

        {cameraId && !camError && (
          <video
            ref={videoRef}
            className={"stage-cam" + (dragging ? " dragging" : "")}
            style={camStyle}
            autoPlay
            playsInline
            muted
            onPointerDown={(e) => {
              if (disabled) return;
              e.preventDefault();
              setDragging({ x: e.clientX, y: e.clientY });
            }}
          />
        )}
      </div>

      {camError ? (
        <p className="muted small">{t("preview.camFailed", { error: camError })}</p>
      ) : (
        <p className="muted small">{cameraId ? t("preview.hint") : t("preview.hintNoCam")}</p>
      )}
    </div>
  );
}
