import { describe, expect, it } from "vitest";

import type { DeviceList } from "../sources";
import {
  DEFAULT_SETUP,
  labelsFor,
  reconcileSetup,
  SIZE_MAX,
  SIZE_MIN,
  type Setup,
} from "../setup";

const dev = (id: string, label = id) => ({ id, label });

/** Uma máquina "cheia": tela principal, uma câmera, um mic e duas saídas. */
const FULL: DeviceList = {
  screens: [dev("primary", "Tela principal")],
  cameras: [dev("Integrated Webcam"), dev("Logitech C920")],
  microphones: [dev("Mic USB"), dev("Array embutido")],
  outputs: [dev("Alto-falantes"), dev("Fone BT")],
};

/** Um setup salvo válido apontando pra devices que existem na FULL. */
const SAVED: Setup = {
  screen: "primary",
  camera: "Logitech C920",
  mic: "Mic USB",
  output: "Fone BT",
  sysOn: true,
  tracks: "separate",
  corner: "tl",
  sizePct: 33,
  labels: {
    "Logitech C920": "Logitech C920",
    "Mic USB": "Mic USB",
    "Fone BT": "Fone BT",
  },
};

describe("reconcileSetup — caso feliz", () => {
  it("(a) setup salvo cujos devices existem é restaurado INTEIRO, sem drops", () => {
    const { setup, dropped } = reconcileSetup(SAVED, FULL);
    expect(dropped).toEqual([]);
    expect(setup.screen).toBe("primary");
    expect(setup.camera).toBe("Logitech C920");
    expect(setup.mic).toBe("Mic USB");
    expect(setup.output).toBe("Fone BT");
    expect(setup.sysOn).toBe(true);
    expect(setup.tracks).toBe("separate");
    expect(setup.corner).toBe("tl");
    expect(setup.sizePct).toBe(33);
  });
});

describe("reconcileSetup — device que sumiu (o bug que a tarefa mira)", () => {
  it("(b) câmera desplugada cai no default (sem câmera) mas PRESERVA o resto", () => {
    // A webcam que estava salva não está mais na lista.
    const list: DeviceList = { ...FULL, cameras: [dev("Integrated Webcam")] };
    const { setup, dropped } = reconcileSetup(SAVED, list);

    // A câmera fantasma NÃO volta — cai em "nenhuma".
    expect(setup.camera).toBe("");
    // ...e o usuário é avisado, com o NOME que estava salvo.
    expect(dropped).toEqual([{ kind: "camera", label: "Logitech C920" }]);

    // Tudo o mais continua de pé: só a câmera sumiu.
    expect(setup.mic).toBe("Mic USB");
    expect(setup.output).toBe("Fone BT");
    expect(setup.tracks).toBe("separate");
    expect(setup.corner).toBe("tl");
    expect(setup.sizePct).toBe(33);
  });

  it("mic que sumiu cai em 'sem áudio' e reporta o drop", () => {
    const list: DeviceList = { ...FULL, microphones: [dev("Array embutido")] };
    const { setup, dropped } = reconcileSetup(SAVED, list);
    expect(setup.mic).toBe("");
    expect(dropped).toEqual([{ kind: "mic", label: "Mic USB" }]);
  });

  it("saída que sumiu cai na saída PADRÃO (a primeira) e reporta — porque sysOn", () => {
    const list: DeviceList = { ...FULL, outputs: [dev("Alto-falantes")] };
    const { setup, dropped } = reconcileSetup(SAVED, list);
    expect(setup.output).toBe("Alto-falantes");
    expect(dropped).toEqual([{ kind: "output", label: "Fone BT" }]);
  });

  it("saída sumida NÃO é reportada quando o áudio do sistema está desligado", () => {
    // Sem sysOn a saída nem entra na gravação: avisar seria ruído.
    const saved: Setup = { ...SAVED, sysOn: false };
    const list: DeviceList = { ...FULL, outputs: [dev("Alto-falantes")] };
    const { setup, dropped } = reconcileSetup(saved, list);
    expect(setup.output).toBe("Alto-falantes"); // ainda cai no default, sem device fantasma
    expect(dropped).toEqual([]);
  });

  it("vários devices somem de uma vez: todos reportados, nenhum id fantasma sobrevive", () => {
    const list: DeviceList = {
      screens: [dev("primary")],
      cameras: [],
      microphones: [],
      outputs: [dev("Alto-falantes")],
    };
    const { setup, dropped } = reconcileSetup(SAVED, list);
    expect(setup.camera).toBe("");
    expect(setup.mic).toBe("");
    expect(setup.output).toBe("Alto-falantes");
    expect(dropped.map((d) => d.kind).sort()).toEqual(["camera", "mic", "output"]);
  });

  it("usa o próprio id no aviso quando não havia rótulo salvo", () => {
    const saved: Setup = { ...SAVED, labels: {} };
    const list: DeviceList = { ...FULL, cameras: [] };
    const { dropped } = reconcileSetup(saved, list);
    expect(dropped).toEqual([{ kind: "camera", label: "Logitech C920" }]);
  });
});

describe("reconcileSetup — layout validado/clampado (storage corrompido)", () => {
  it("(c) sizePct fora da faixa é clampado pros limites do slider", () => {
    expect(reconcileSetup({ ...SAVED, sizePct: 999 }, FULL).setup.sizePct).toBe(SIZE_MAX);
    expect(reconcileSetup({ ...SAVED, sizePct: 1 }, FULL).setup.sizePct).toBe(SIZE_MIN);
    // Lixo não-numérico não vira NaN na tela: cai no default.
    expect(reconcileSetup({ ...SAVED, sizePct: NaN }, FULL).setup.sizePct).toBe(
      DEFAULT_SETUP.sizePct,
    );
  });

  it("corner/tracks inválidos caem no default", () => {
    const bad = { ...SAVED, corner: "xyz", tracks: "loud" } as unknown as Setup;
    const { setup } = reconcileSetup(bad, FULL);
    expect(setup.corner).toBe("br");
    expect(setup.tracks).toBe("mixed");
  });
});

describe("reconcileSetup — bordas", () => {
  it("setup nulo (primeira execução) devolve os defaults, sem estourar", () => {
    const { setup, dropped } = reconcileSetup(null, FULL);
    expect(dropped).toEqual([]);
    expect(setup.camera).toBe("");
    expect(setup.corner).toBe("br");
    expect(setup.sizePct).toBe(DEFAULT_SETUP.sizePct);
    // A tela sempre resolve pra principal mesmo sem nada salvo.
    expect(setup.screen).toBe("primary");
  });

  it("tela salva que sumiu cai na principal, em silêncio (não é 'drop' reportável)", () => {
    const saved: Setup = { ...SAVED, screen: "monitor-2" };
    const { setup, dropped } = reconcileSetup(saved, FULL);
    expect(setup.screen).toBe("primary");
    expect(dropped.some((d) => (d.kind as string) === "screen")).toBe(false);
  });
});

describe("labelsFor", () => {
  it("colhe o rótulo só dos ids escolhidos, ignorando vazios e desconhecidos", () => {
    const map = labelsFor(FULL, ["Logitech C920", "", "Mic USB", "id-que-nao-existe"]);
    expect(map).toEqual({ "Logitech C920": "Logitech C920", "Mic USB": "Mic USB" });
  });
});
