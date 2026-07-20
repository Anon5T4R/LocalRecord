import { afterEach, describe, expect, it } from "vitest";

import {
  loadSections,
  parseSections,
  saveSections,
  sectionOpen,
  toggled,
  type SectionState,
} from "../sections";

/**
 * `localStorage` de mentira, com os dois modos de falha que importam: o normal
 * e o BLOQUEADO (modo restrito do navegador / storage cheio), onde `setItem` e
 * `getItem` lançam. Preferência de layout não pode derrubar o app.
 */
function fakeStorage(opts: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  g.localStorage = {
    getItem(k: string) {
      if (opts.throws) throw new Error("bloqueado");
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (opts.throws) throw new Error("bloqueado");
      map.set(k, v);
    },
  };
  return map;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("sectionOpen — a regra do B9", () => {
  it("seção com valor NÃO-NEUTRO nasce aberta", () => {
    // O coração do item: um ajuste ligado, mudando o comportamento, não pode
    // nascer escondido. É o bug de "o app está estranho e não sei por quê".
    expect(sectionOpen({}, "audio", true)).toBe(true);
  });

  it("seção neutra nasce fechada", () => {
    expect(sectionOpen({}, "color", false)).toBe(false);
  });

  it("a opinião do usuário vence o padrão — nos DOIS sentidos", () => {
    // Fechar o que nasceria aberto…
    expect(sectionOpen({ audio: false }, "audio", true)).toBe(false);
    // …e abrir o que nasceria fechado. O segundo é o que prova que o estado
    // guardado não é só um "conjunto de fechadas".
    expect(sectionOpen({ color: true }, "color", false)).toBe(true);
  });

  it("opinião sobre OUTRA seção não vaza pra esta", () => {
    expect(sectionOpen({ audio: false }, "color", true)).toBe(true);
  });
});

describe("parseSections", () => {
  it("aceita o caso feliz", () => {
    expect(parseSections('{"audio":false,"color":true}')).toEqual({
      audio: false,
      color: true,
    });
  });

  it.each([
    ["chave ausente", null],
    ["string vazia", ""],
    ["JSON quebrado", "{isto não é json"],
    ["array em vez de objeto", "[1,2,3]"],
    ["null literal", "null"],
    ["número solto", "42"],
  ])("devolve {} em %s (e aí o padrão volta a valer)", (_nome, raw) => {
    expect(parseSections(raw)).toEqual({});
  });

  it("descarta valor que não é booleano, mantendo o resto", () => {
    // Uma versão futura (ou outra aba) pode gravar outra coisa. Um `"sim"`
    // virando `open` truthy seria um estado que ninguém previu.
    expect(parseSections('{"audio":false,"color":"sim","speed":1,"crop":true}')).toEqual({
      audio: false,
      crop: true,
    });
  });
});

describe("persistência — sobrevive ao reinício", () => {
  it("o que foi gravado numa sessão é lido na seguinte", () => {
    // Este teste É a prova pedida: grava com um "processo", joga fora o estado
    // em memória e lê de novo do storage, como faria um app reaberto.
    fakeStorage();
    const KEY = "localrecord.sections";

    let sessao1: SectionState = loadSections(KEY);
    expect(sessao1).toEqual({}); // primeira execução: ninguém opinou
    sessao1 = toggled(sessao1, "audio", false);
    sessao1 = toggled(sessao1, "color", true);
    saveSections(KEY, sessao1);

    const sessao2 = loadSections(KEY);
    expect(sessao2).toEqual({ audio: false, color: true });
    // E a regra continua valendo por cima do que voltou:
    expect(sectionOpen(sessao2, "audio", true)).toBe(false);
    expect(sectionOpen(sessao2, "color", false)).toBe(true);
    expect(sectionOpen(sessao2, "speed", true)).toBe(true);
  });

  it("chave de outro app não é lida", () => {
    fakeStorage();
    saveSections("localvideo.sections", { audio: false });
    expect(loadSections("localrecord.sections")).toEqual({});
  });

  it("storage bloqueado não derruba nada", () => {
    fakeStorage({ throws: true });
    expect(() => saveSections("localrecord.sections", { audio: false })).not.toThrow();
    expect(loadSections("localrecord.sections")).toEqual({});
  });

  it("sem localStorage (Node puro) também não derruba", () => {
    expect(loadSections("localrecord.sections")).toEqual({});
    expect(() => saveSections("localrecord.sections", { audio: false })).not.toThrow();
  });
});

describe("toggled", () => {
  it("não muta o estado anterior", () => {
    const antes: SectionState = { audio: false };
    const depois = toggled(antes, "color", true);
    expect(antes).toEqual({ audio: false });
    expect(depois).toEqual({ audio: false, color: true });
  });
});
