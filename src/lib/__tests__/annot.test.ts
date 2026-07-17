import { describe, expect, it } from "vitest";
import {
  distToSegment,
  eraseAt,
  itemHit,
  shouldAppend,
  type Item,
  type Stroke,
  type TextItem,
} from "../annot";

const stroke = (pts: [number, number][], width = 6): Stroke => ({
  kind: "stroke",
  pts: pts.map(([x, y]) => ({ x, y })),
  color: "#ef4444",
  width,
});

const text = (x: number, y: number, s: string): TextItem => ({
  kind: "text",
  at: { x, y },
  text: s,
  color: "#ef4444",
  size: 24,
});

describe("distToSegment", () => {
  it("mede até o segmento, não até a reta infinita", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    // Em cima do meio: a distância é a perpendicular.
    expect(distToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3);
    // Muito além da ponta: quem manda é a PONTA (a reta infinita diria 3, e a
    // borracha apagaria um traço que está a 100px de distância).
    expect(distToSegment({ x: 110, y: 3 }, a, b)).toBeCloseTo(Math.hypot(100, 3));
  });

  it("aguenta traço de um ponto só (toque sem arrastar)", () => {
    const a = { x: 4, y: 4 };
    // Segmento degenerado não pode virar divisão por zero → NaN → borracha
    // que nunca apaga nada.
    expect(distToSegment({ x: 4, y: 9 }, a, a)).toBeCloseTo(5);
  });
});

describe("itemHit", () => {
  it("conta a espessura do traço na tolerância", () => {
    const s = stroke(
      [
        [0, 0],
        [100, 0],
      ],
      20,
    );
    // Centro a 14px, mas o traço tem 20 de espessura (10 de raio) e a borracha
    // 5: 14 <= 5+10. O usuário vê tinta ali, então tem que apagar.
    expect(itemHit(s, { x: 50, y: 14 }, 5)).toBe(true);
    expect(itemHit(s, { x: 50, y: 40 }, 5)).toBe(false);
  });

  it("pega o texto pela caixa, inclusive na diagonal", () => {
    const t = text(100, 100, "oi");
    expect(itemHit(t, { x: 105, y: 95 }, 5)).toBe(true);
    expect(itemHit(t, { x: 400, y: 400 }, 5)).toBe(false);
  });
});

describe("eraseAt", () => {
  it("tira só o que a borracha encostou e devolve lista nova", () => {
    const perto = stroke([
      [0, 0],
      [10, 10],
    ]);
    const longe = stroke([
      [500, 500],
      [510, 510],
    ]);
    const items: Item[] = [perto, longe, text(600, 600, "zz")];
    const out = eraseAt(items, { x: 5, y: 5 }, 8);
    expect(out).toHaveLength(2);
    expect(out).not.toContain(perto);
    // Identidade trocada: senão o React não redesenha.
    expect(out).not.toBe(items);
    // E a lista original fica intacta (a borracha não muta o passado).
    expect(items).toHaveLength(3);
  });
});

describe("shouldAppend", () => {
  it("descarta o ruído parado e aceita movimento de verdade", () => {
    const pts = [{ x: 10, y: 10 }];
    expect(shouldAppend([], { x: 0, y: 0 })).toBe(true);
    expect(shouldAppend(pts, { x: 10.5, y: 10 })).toBe(false);
    expect(shouldAppend(pts, { x: 14, y: 10 })).toBe(true);
  });
});
