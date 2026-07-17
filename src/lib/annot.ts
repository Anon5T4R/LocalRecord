/** Modelo e geometria da anotação ao vivo — funções PURAS (unit-testadas).
 *
 *  Mesma regra da casa do `args.ts`: o que dá pra decidir sem tocar em canvas,
 *  janela ou ffmpeg mora aqui e tem teste. O componente só desenha o resultado.
 *
 *  Por que o traço é uma LISTA DE OBJETOS e não pixel no canvas: a borracha.
 *  Apagar com `globalCompositeOperation="destination-out"` risca um buraco na
 *  imagem — irreversível, e some com o texto que estiver por baixo junto. Com
 *  objetos, apagar é tirar o item da lista e redesenhar: a borracha vira uma
 *  operação exata, e o "limpar tudo" vira `[]`.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Stroke {
  kind: "stroke";
  pts: Pt[];
  color: string;
  width: number;
}

export interface TextItem {
  kind: "text";
  at: Pt;
  text: string;
  color: string;
  size: number;
}

export type Item = Stroke | TextItem;

/** Ferramentas da v0.1. */
export type Tool = "pen" | "text" | "eraser";

/** Paleta do overlay: cores que sobrevivem em cima de QUALQUER tela.
 *  Nada de cinza/preto — o fundo pode ser um editor escuro ou um site branco. */
export const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"] as const;

export const WIDTHS = [3, 6, 12] as const;

/** Distância de um ponto até o SEGMENTO ab (não até a reta infinita).
 *  A diferença importa: a borracha perto do prolongamento de um traço curto não
 *  pode apagá-lo. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  // Segmento degenerado (um ponto só — um toque de caneta sem arrastar).
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Projeção grampeada em [0,1] = o ponto mais próximo DENTRO do segmento.
  const tRaw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const t = Math.min(1, Math.max(0, tRaw));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Caixa aproximada de um texto. Não mede fonte de verdade (isso exigiria o
 *  canvas, e aí a função deixaria de ser pura): 0,55em por caractere é a média
 *  de uma sans, e a borracha é grossa o bastante pro erro não aparecer. */
export function textBox(it: TextItem): { x: number; y: number; w: number; h: number } {
  return {
    x: it.at.x,
    y: it.at.y - it.size,
    w: Math.max(it.size, it.text.length * it.size * 0.55),
    h: it.size * 1.3,
  };
}

/** O item encosta no círculo da borracha (centro `p`, raio `r`)? */
export function itemHit(item: Item, p: Pt, r: number): boolean {
  if (item.kind === "text") {
    const b = textBox(item);
    // Ponto mais próximo da caixa, e daí a distância — pega a borracha
    // chegando por qualquer lado, inclusive na diagonal.
    const nx = Math.min(Math.max(p.x, b.x), b.x + b.w);
    const ny = Math.min(Math.max(p.y, b.y), b.y + b.h);
    return Math.hypot(p.x - nx, p.y - ny) <= r;
  }
  // A tolerância soma a metade da espessura: um traço gordo é "encostado" antes
  // que o centro dele chegue no raio da borracha.
  const tol = r + item.width / 2;
  if (item.pts.length === 1) return Math.hypot(p.x - item.pts[0].x, p.y - item.pts[0].y) <= tol;
  for (let i = 1; i < item.pts.length; i++) {
    if (distToSegment(p, item.pts[i - 1], item.pts[i]) <= tol) return true;
  }
  return false;
}

/** Apaga o que a borracha encostou. Devolve lista NOVA (o React precisa da
 *  identidade trocada pra redesenhar). */
export function eraseAt(items: Item[], p: Pt, r: number): Item[] {
  return items.filter((it) => !itemHit(it, p, r));
}

/** Ponto novo entra no traço? Filtra o ruído do mouse: dezenas de eventos por
 *  segundo no mesmo pixel só engordam a lista e deixam o redraw lento numa aula
 *  de uma hora. 1,5px é abaixo do que o olho pega. */
export function shouldAppend(pts: Pt[], p: Pt): boolean {
  const last = pts[pts.length - 1];
  if (!last) return true;
  return Math.hypot(p.x - last.x, p.y - last.y) >= 1.5;
}
