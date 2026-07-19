/** Fundo virtual da câmera — regras PURAS (sem canvas, sem modelo, sem React).
 *
 *  Aqui mora só o que dá pra cravar em teste: validação do que veio do storage,
 *  a regra de queda quando o fundo escolhido não é utilizável, e a geometria de
 *  "cobrir" a caixa da câmera com uma imagem de outro aspecto. O trabalho sujo
 *  (worker, ONNX, composição) fica em `segmenter.ts` e no AnnotOverlay.
 *
 *  DECISÃO QUE MOLDA O MÓDULO INTEIRO: a imagem de fundo é guardada como data
 *  URL (pixels), NÃO como caminho de arquivo. Custou consideração porque o
 *  caminho é o óbvio — mas caminho traz de volta o problema que o
 *  `reconcileSetup` já sofre com device: o arquivo some (pendrive, pasta
 *  renomeada, Downloads limpo) e a gravação sai com fundo preto sem ninguém
 *  entender. Guardando os pixels, o fundo escolhido em março ainda funciona em
 *  dezembro, offline, sem tocar em disco e sem escopo de asset protocol no
 *  Tauri. O preço é o tamanho no localStorage — pago com a reamostragem em
 *  `BG_IMAGE_MAX_DIM` antes de salvar.
 */

/** Os três modos. `none` = comportamento de sempre (o `<video>` cru), e é o
 *  default: quem nunca mexer no controle não paga CPU nenhuma nem tem um único
 *  quadro do take alterado. */
export const CAM_BGS = ["none", "blur", "image"] as const;
export type CamBg = (typeof CAM_BGS)[number];

export const DEFAULT_CAM_BG: CamBg = "none";

/** Maior lado da imagem de fundo depois de reamostrada, antes de virar data
 *  URL. A câmera ocupa 10–40% da largura da tela (ver SIZE_MIN/MAX) — numa tela
 *  4K isso dá no máximo ~1536 px de largura, então 1280 cobre o uso real com
 *  folga e ainda mantém o data URL na casa das dezenas de KB. Guardar o
 *  original de 12 MP estouraria o localStorage e não apareceria na tela. */
export const BG_IMAGE_MAX_DIM = 1280;

/** Teto do data URL guardado. O localStorage costuma ter ~5 MB no total, e ele
 *  é COMPARTILHADO com o resto do setup — uma imagem gigante aqui derrubaria o
 *  save inteiro (o `saveSetup` engole a exceção, então o usuário perderia as
 *  outras escolhas em silêncio). 2 MB deixa margem larga pro resto. */
export const BG_IMAGE_MAX_CHARS = 2 * 1024 * 1024;

/** Desfoque do fundo, em px de canvas. Forte o bastante pra descaracterizar a
 *  bagunça atrás de quem grava (que é o pedido real), fraco o bastante pra não
 *  virar um borrão colorido que chama mais atenção que a pessoa. */
export const BG_BLUR_PX = 12;

/** Valida o modo vindo do storage. Lista fechada e não faixa: um valor
 *  corrompido viraria `globalCompositeOperation` inválido lá na composição, e o
 *  sintoma seria a câmera SUMIR do take — caro demais pra descobrir depois. */
export function normalizeCamBg(v: unknown): CamBg {
  return (CAM_BGS as readonly unknown[]).includes(v) ? (v as CamBg) : DEFAULT_CAM_BG;
}

/** Valida a imagem de fundo vinda do storage.
 *
 *  Exige o prefixo `data:image/` de propósito: o valor vira `src` de um
 *  `<img>`/`createImageBitmap` dentro da janela de anotação, então aceitar
 *  string arbitrária seria deixar o storage escolher uma URL que o overlay vai
 *  buscar. Não é paranoia teórica — o localStorage é editável por qualquer
 *  coisa que rode no webview, e a janela de anotação é a que aparece no vídeo.
 */
export function normalizeCamBgImage(v: unknown): string {
  if (typeof v !== "string") return "";
  if (!v.startsWith("data:image/")) return "";
  if (v.length > BG_IMAGE_MAX_CHARS) return "";
  return v;
}

/** O modo que REALMENTE vale, dado o que está guardado.
 *
 *  `image` sem imagem cai pra `none` e não pra `blur`: o usuário pediu uma foto
 *  específica; entregar desfoque no lugar seria inventar uma escolha que ele não
 *  fez. `none` é o único fundo que nunca surpreende. Mesma filosofia do
 *  `reconcileSetup` — o que não dá pra honrar volta pro default, nunca pro
 *  "parecido". */
export function effectiveCamBg(bg: CamBg, image: string): CamBg {
  if (bg === "image" && !image) return "none";
  return bg;
}

/** Precisa de segmentação? É o que decide se o modelo e o worker sequer sobem.
 *  `none` não carrega nada — o custo de CPU medido no spike (~13,7 ms por
 *  quadro num núcleo) só existe pra quem pediu fundo. */
export function needsSegmentation(bg: CamBg): boolean {
  return bg === "blur" || bg === "image";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Retângulo de origem pra desenhar `src` COBRINDO `dst` sem distorcer
 * (equivalente ao `object-fit: cover`): recorta o excesso do lado mais longo e
 * centraliza.
 *
 * Existe porque a caixa da câmera tem o aspecto da WEBCAM (16/9, 4/3, o que o
 * aparelho der) e a imagem que o usuário escolhe tem o aspecto dela — esticar
 * uma na outra deixa rosto de foto de fundo achatado, que é exatamente o tipo de
 * detalhe que só aparece no take pronto.
 */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  // Degenerado (imagem ainda não carregada, canvas zerado): devolve algo
  // desenhável em vez de NaN — `drawImage` com NaN lança e mataria o quadro.
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { x: 0, y: 0, w: Math.max(1, srcW), h: Math.max(1, srcH) };
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    // Origem mais LARGA que o destino: sobra nas laterais, corta em x.
    const w = srcH * dstAspect;
    return { x: (srcW - w) / 2, y: 0, w, h: srcH };
  }
  // Origem mais ALTA: sobra em cima/embaixo, corta em y.
  const h = srcW / dstAspect;
  return { x: 0, y: (srcH - h) / 2, w: srcW, h };
}

/**
 * Tamanho de destino ao reamostrar a imagem escolhida pra dentro de
 * `BG_IMAGE_MAX_DIM`, preservando o aspecto. Imagem já pequena NÃO é ampliada:
 * subir a resolução só inflaria o data URL sem acrescentar um pixel de detalhe.
 */
export function fitWithin(w: number, h: number, max: number = BG_IMAGE_MAX_DIM): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 1, h: 1 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}
