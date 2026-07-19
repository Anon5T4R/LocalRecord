import { describe, expect, it } from "vitest";
import {
  BG_IMAGE_MAX_CHARS,
  BG_IMAGE_MAX_DIM,
  coverRect,
  effectiveCamBg,
  fitWithin,
  needsSegmentation,
  normalizeCamBg,
  normalizeCamBgImage,
} from "../cambg";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("normalizeCamBg", () => {
  it("aceita os três modos", () => {
    expect(normalizeCamBg("none")).toBe("none");
    expect(normalizeCamBg("blur")).toBe("blur");
    expect(normalizeCamBg("image")).toBe("image");
  });

  // O ponto do teste: storage corrompido não pode vazar pra composição.
  it("qualquer outra coisa vira 'none'", () => {
    for (const junk of ["greenscreen", "", null, undefined, 3, {}, []]) {
      expect(normalizeCamBg(junk)).toBe("none");
    }
  });
});

describe("normalizeCamBgImage", () => {
  it("aceita data URL de imagem", () => {
    expect(normalizeCamBgImage(PNG)).toBe(PNG);
  });

  // O overlay é a janela que APARECE NO VÍDEO: o storage não escolhe uma URL
  // remota pra ela buscar.
  it("recusa o que não é data:image/", () => {
    expect(normalizeCamBgImage("https://exemplo.com/f.png")).toBe("");
    expect(normalizeCamBgImage("data:text/html,<script>")).toBe("");
    expect(normalizeCamBgImage("file:///C:/foto.png")).toBe("");
    expect(normalizeCamBgImage("javascript:alert(1)")).toBe("");
  });

  it("recusa não-string", () => {
    for (const junk of [null, undefined, 42, {}, []]) expect(normalizeCamBgImage(junk)).toBe("");
  });

  // Uma imagem gigante derrubaria o save do setup INTEIRO, e em silêncio.
  it("recusa acima do teto", () => {
    const big = "data:image/png;base64," + "A".repeat(BG_IMAGE_MAX_CHARS);
    expect(normalizeCamBgImage(big)).toBe("");
  });

  it("aceita exatamente no teto", () => {
    const edge = "data:image/png;base64," + "A".repeat(BG_IMAGE_MAX_CHARS - "data:image/png;base64,".length);
    expect(edge.length).toBe(BG_IMAGE_MAX_CHARS);
    expect(normalizeCamBgImage(edge)).toBe(edge);
  });
});

describe("effectiveCamBg", () => {
  // A regra do reconcileSetup aplicada ao fundo: o que não dá pra honrar volta
  // pro default, nunca pro "parecido".
  it("'image' sem imagem cai pra 'none', não pra 'blur'", () => {
    expect(effectiveCamBg("image", "")).toBe("none");
  });

  it("'image' com imagem fica", () => {
    expect(effectiveCamBg("image", PNG)).toBe("image");
  });

  it("'blur' não depende de imagem", () => {
    expect(effectiveCamBg("blur", "")).toBe("blur");
  });

  it("'none' fica 'none'", () => {
    expect(effectiveCamBg("none", PNG)).toBe("none");
  });
});

describe("needsSegmentation", () => {
  // O contrato que garante custo ZERO pra quem não pediu fundo: sem isto o
  // worker e o modelo subiriam à toa e cobrariam CPU do encoder.
  it("'none' não segmenta", () => {
    expect(needsSegmentation("none")).toBe(false);
  });

  it("blur e image segmentam", () => {
    expect(needsSegmentation("blur")).toBe(true);
    expect(needsSegmentation("image")).toBe(true);
  });
});

describe("coverRect", () => {
  it("mesmo aspecto: usa a imagem inteira", () => {
    const r = coverRect(1920, 1080, 640, 360);
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("origem mais larga: corta as laterais e centraliza", () => {
    // 2000x1000 (2:1) dentro de 16:9 -> mantém a altura, corta em x.
    const r = coverRect(2000, 1000, 1600, 900);
    expect(r.h).toBe(1000);
    expect(r.y).toBe(0);
    expect(r.w).toBeCloseTo(1000 * (16 / 9), 5);
    expect(r.x).toBeCloseTo((2000 - 1000 * (16 / 9)) / 2, 5);
  });

  it("origem mais alta: corta em cima/embaixo e centraliza", () => {
    // Retrato 1000x2000 dentro de 16:9 -> mantém a largura, corta em y.
    const r = coverRect(1000, 2000, 1600, 900);
    expect(r.w).toBe(1000);
    expect(r.x).toBe(0);
    expect(r.h).toBeCloseTo(1000 / (16 / 9), 5);
    expect(r.y).toBeCloseTo((2000 - 1000 / (16 / 9)) / 2, 5);
  });

  it("o recorte nunca sai da imagem", () => {
    for (const [sw, sh] of [
      [4000, 300],
      [300, 4000],
      [1920, 1080],
      [640, 480],
    ]) {
      const r = coverRect(sw, sh, 480, 270);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(sw + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(sh + 1e-6);
    }
  });

  // `drawImage` com NaN lança e mataria o quadro inteiro.
  it("degenerado devolve algo desenhável, nunca NaN", () => {
    const casos: Array<[number, number, number, number]> = [
      [0, 0, 100, 100],
      [100, 100, 0, 0],
      [-5, 10, 100, 100],
    ];
    for (const [sw, sh, dw, dh] of casos) {
      const r = coverRect(sw, sh, dw, dh);
      for (const n of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(n)).toBe(true);
    }
  });
});

describe("fitWithin", () => {
  it("reduz respeitando o aspecto", () => {
    const r = fitWithin(4000, 3000);
    expect(Math.max(r.w, r.h)).toBe(BG_IMAGE_MAX_DIM);
    expect(r.w / r.h).toBeCloseTo(4000 / 3000, 2);
  });

  it("retrato também cabe no teto", () => {
    const r = fitWithin(3000, 4000);
    expect(Math.max(r.w, r.h)).toBe(BG_IMAGE_MAX_DIM);
  });

  // Ampliar só infla o data URL sem acrescentar detalhe.
  it("não amplia imagem pequena", () => {
    expect(fitWithin(320, 240)).toEqual({ w: 320, h: 240 });
  });

  it("degenerado não vira 0 nem NaN", () => {
    expect(fitWithin(0, 0)).toEqual({ w: 1, h: 1 });
    const r = fitWithin(1, 100000);
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});
