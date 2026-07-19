/** Constantes compartilhadas entre o worker de segmentação e quem o usa.
 *
 *  Módulo separado (e sem imports) de propósito: o worker é carregado por
 *  `new Worker(new URL(...))` e puxar `cambg.ts` ou qualquer coisa com React
 *  junto arrastaria meio app pro bundle dele. */

/** Lado da entrada do modelo. Fixo em 256 porque é o que o
 *  `mediapipe_selfie_segmentation` (general) declara: `[batch,3,256,256]` →
 *  `[batch,1,256,256]`. Não é um botão de qualidade — outro valor não roda. */
export const SEG_DIM = 256;

/** Onde o modelo mora, servido pelo próprio webview (public/). Não passa por
 *  asset protocol nem por download em tempo de execução: são 462 KB que o
 *  `scripts/fetch-model` traz na hora do build e o vite copia pro dist. */
export const SEG_MODEL_URL = "models/mediapipe-selfie-segmentation.onnx";
