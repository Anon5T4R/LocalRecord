import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

/**
 * Abre a câmera pro preview. O casamento entre o id do dshow e o
 * `MediaDeviceInfo` é por RÓTULO — não existe id comum entre os dois mundos.
 * Os rótulos só aparecem depois que a permissão é dada, daí a ordem: pedir
 * primeiro, escolher depois.
 */
async function openCamera(id: string): Promise<MediaStream> {
  const first = await navigator.mediaDevices.getUserMedia({ video: true });
  const devices = await navigator.mediaDevices.enumerateDevices();
  const match =
    devices.find((d) => d.kind === "videoinput" && d.label === id) ??
    devices.find((d) => d.kind === "videoinput" && d.label.startsWith(id));
  // A câmera que já abriu é a certa (ou não há como saber): fica essa mesma.
  if (!match || first.getVideoTracks()[0]?.label === match.label) return first;
  // Era outra: solta a primeira antes de abrir a segunda — duas câmeras vivas
  // ao mesmo tempo travam o dispositivo em algumas webcams.
  for (const tr of first.getTracks()) tr.stop();
  return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: match.deviceId } } });
}

export default function Preview(props: Props) {
  const { grabber, cameraId, corner, sizePct, onCornerChange, disabled } = props;
  const [thumb, setThumb] = useState<string>("");
  const [camError, setCamError] = useState("");
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Aspecto do palco = o da tela de verdade, senão a prévia mente sobre o
  // enquadramento.
  const screenW = typeof window !== "undefined" ? window.screen.width : 1920;
  const screenH = typeof window !== "undefined" ? window.screen.height : 1080;

  // Um quadro da tela como fundo. Falha aqui não é fatal: o palco continua
  // servindo pra posicionar a câmera, só fica sem a foto atrás.
  useEffect(() => {
    let url = "";
    let alive = true;
    invoke<number[]>("rec_screen_thumb", { args: buildThumbArgs(grabber) })
      .then((bytes) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
        setThumb(url);
      })
      .catch(() => setThumb(""));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [grabber]);

  // Câmera ao vivo no palco — SÓ enquanto parado.
  //
  // Soltar a webcam ao gravar não é economia: é o ffmpeg que precisa dela. Uma
  // webcam aberta aqui e pedida lá é o mesmo aparelho com dois donos, e quem
  // perde é a gravação — a entrada `dshow` fica sem quadro, o `overlay` do
  // grafo espera por um quadro que não vem e SEGURA o vídeo inteiro. Bate com
  // o que os testes reais do João mostraram: câmera fora do arquivo, fps no
  // chão e o `ddagrab` perdendo o acesso, tudo só quando havia câmera ligada.
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
