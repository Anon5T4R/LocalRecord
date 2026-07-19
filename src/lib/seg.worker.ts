/** Worker de segmentação da webcam — o único lugar do app que roda o modelo.
 *
 *  POR QUE UM WORKER, e não a thread principal: o spike mediu ~13,7 ms por
 *  quadro só de inferência (mediana, wasm de uma thread, nesta máquina). O
 *  orçamento de um quadro a 30 fps é 33 ms — rodar isso na thread principal
 *  comeria 40% dela e o overlay é justamente a janela que o `ddagrab` FILMA:
 *  travar aqui é travar a imagem que vai pro arquivo. No worker a inferência
 *  cai noutro núcleo e a thread principal só compõe (~1–2 ms medidos).
 *
 *  O protocolo é deliberadamente burro (um pedido → uma máscara) e quem impede
 *  fila é o chamador, mandando um quadro por vez (ver `segmenter.ts`).
 */

// O subpath /wasm importa o bundle SÓ-CPU. O entry padrão traz o backend webgpu
// (JSEP) e em runtime pede `ort-wasm-simd-threaded.jsep.mjs`, que não
// embarcamos — morrendo com "no available backend found" NO APP INSTALADO
// enquanto funciona em dev. Foi um bug real do LocalPaint (v0.5.0); a lição
// chega aqui de graça.
import * as ort from "onnxruntime-web/wasm";
// Os DOIS arquivos do runtime entram pelo pipeline do vite (?url): em dev viram
// URL servida como módulo de verdade, no build viram assets emitidos. Cópia em
// public/ NÃO funciona — o vite não deixa importar módulo de lá.
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

import { SEG_DIM } from "./segtypes";

ort.env.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
// Uma thread: a build multithread exige COOP/COEP, que o LocalRecord não manda
// (e mandar isolaria a janela por causa de um recurso opcional). O spike mediu
// com numThreads=1 justamente pra não prometer um número que o app não entrega.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

let session: ort.InferenceSession | null = null;

/** Pixels do quadro (RGBA, SEG_DIM²) → tensor NCHW normalizado 0..1.
 *  Reaproveitado entre quadros: alocar 768 KB de float 30 vezes por segundo
 *  daria trabalho ao GC bem no caminho quente. */
const nchw = new Float32Array(3 * SEG_DIM * SEG_DIM);

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      const res = await fetch(msg.url);
      // Cheque explícito: sem ele o corpo do 404 (uma página HTML) iria parar
      // no onnxruntime e o diagnóstico viraria adivinhação — lição do
      // LocalVideo com o asset protocol.
      if (!res.ok) throw new Error(`modelo ${res.status}`);
      const buf = await res.arrayBuffer();
      session = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["wasm"] });
      (self as unknown as Worker).postMessage({ type: "ready" });
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: "failed", error: String(err) });
    }
    return;
  }

  if (msg.type === "frame") {
    if (!session) return;
    try {
      const px = msg.pixels as Uint8ClampedArray;
      const n = SEG_DIM * SEG_DIM;
      for (let i = 0; i < n; i++) {
        nchw[i] = px[i * 4] / 255;
        nchw[n + i] = px[i * 4 + 1] / 255;
        nchw[2 * n + i] = px[i * 4 + 2] / 255;
      }
      const out = await session.run({
        pixel_values: new ort.Tensor("float32", nchw, [1, 3, SEG_DIM, SEG_DIM]),
      });
      const alphas = out.alphas.data as Float32Array;

      // Float32 → Uint8 AQUI: são 256 KB de float contra 64 KB de byte na volta,
      // e a conversão é trabalho que a thread principal não precisa fazer.
      // A máscara já sai como RGBA branco-com-alpha pra virar `putImageData`
      // direto do outro lado, sem mais um laço lá.
      const rgba = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        rgba[i * 4] = 255;
        rgba[i * 4 + 1] = 255;
        rgba[i * 4 + 2] = 255;
        rgba[i * 4 + 3] = alphas[i] * 255;
      }
      (self as unknown as Worker).postMessage({ type: "mask", rgba }, [rgba.buffer]);
    } catch {
      // Um quadro que falhou não derruba a sessão: o chamador segue com a
      // máscara anterior e a gravação não vê diferença. Avisar aqui só geraria
      // ruído 30 vezes por segundo.
      (self as unknown as Worker).postMessage({ type: "mask", rgba: null });
    }
  }
};
