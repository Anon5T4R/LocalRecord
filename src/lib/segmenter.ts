/** Dono do worker de segmentação: sobe, alimenta e derruba.
 *
 *  A REGRA QUE FAZ A FEATURE CABER NO ORÇAMENTO: um quadro por vez. Enquanto o
 *  worker está ocupado, quadro novo é DESCARTADO em vez de enfileirado.
 *
 *  É essa linha que transforma o custo medido (~13,7 ms de inferência) num
 *  custo que a gravação não sente. Com fila, uma CPU ocupada acumularia
 *  pedidos, a máscara ficaria cada vez mais velha e a memória cresceria sem
 *  limite — o clássico "ficou lento e depois travou". Descartando, a
 *  segmentação vira ELÁSTICA: em máquina folgada atualiza a ~70 vezes por
 *  segundo, em máquina apertada atualiza menos e mais nada muda. A composição
 *  segue a 30 fps com a última máscara boa, e o take nunca perde quadro por
 *  causa do fundo.
 *
 *  Máscara velha por alguns quadros custa uma borda que "arrasta" um pouco num
 *  movimento brusco. Quadro perdido custa o take. A escolha não é difícil.
 */

import { SEG_DIM, SEG_MODEL_URL } from "./segtypes";

export type SegStatus = "loading" | "ready" | "failed";

export interface Segmenter {
  /** Manda um quadro. Se o worker está ocupado, o quadro é ignorado — de
   *  propósito, ver o cabeçalho. */
  push(pixels: Uint8ClampedArray): void;
  /** A máscara mais recente (RGBA branco + alpha, SEG_DIM²), ou null enquanto
   *  a primeira não chegou. Quem compõe decide o que fazer sem máscara. */
  mask(): ImageData | null;
  status(): SegStatus;
  dispose(): void;
}

export function createSegmenter(onStatus?: (s: SegStatus) => void): Segmenter {
  let status: SegStatus = "loading";
  let busy = false;
  let disposed = false;
  let latest: ImageData | null = null;

  const setStatus = (s: SegStatus) => {
    status = s;
    onStatus?.(s);
  };

  // `type: module` + URL relativa: é o que o vite reconhece pra emitir o worker
  // como chunk próprio no build (e servir em dev). String literal solta viraria
  // 404 no instalador.
  const worker = new Worker(new URL("./seg.worker.ts", import.meta.url), { type: "module" });

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === "ready") {
      setStatus("ready");
      return;
    }
    if (msg.type === "failed") {
      setStatus("failed");
      return;
    }
    if (msg.type === "mask") {
      busy = false;
      if (msg.rgba) latest = new ImageData(msg.rgba as Uint8ClampedArray, SEG_DIM, SEG_DIM);
    }
  };

  // Worker que morre (OOM, wasm recusado) não pode deixar a UI esperando pra
  // sempre por uma máscara que não vem.
  worker.onerror = () => {
    busy = false;
    setStatus("failed");
  };

  // O modelo é resolvido contra a base do documento: no instalador a página do
  // overlay é `annot.html` e um caminho absoluto (`/models/...`) apontaria pra
  // raiz do protocolo tauri://, que não é onde o vite põe os assets.
  worker.postMessage({ type: "init", url: new URL(SEG_MODEL_URL, document.baseURI).href });

  return {
    push(pixels) {
      if (disposed || busy || status !== "ready") return;
      busy = true;
      // Cópia + transferência: o `pixels` vem de um `getImageData` que o
      // chamador reusa no quadro seguinte, então mandar o buffer original o
      // deixaria destacado (byteLength 0) e o próximo quadro sairia preto.
      const copy = new Uint8ClampedArray(pixels);
      worker.postMessage({ type: "frame", pixels: copy }, [copy.buffer]);
    },
    mask: () => latest,
    status: () => status,
    dispose() {
      disposed = true;
      latest = null;
      worker.terminate();
    },
  };
}
