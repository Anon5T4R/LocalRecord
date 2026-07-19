import { describe, expect, it } from "vitest";

import type { DeviceList } from "../sources";
import {
  DEFAULT_SETUP,
  labelsFor,
  OPACITY_MAX,
  OPACITY_MIN,
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
  micFilter: true,
  tracks: "separate",
  corner: "tl",
  sizePct: 33,
  camOpacity: 70,
  camBg: "none",
  camBgImage: "",
  fps: 60,
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
    expect(setup.micFilter).toBe(true);
    expect(setup.tracks).toBe("separate");
    expect(setup.corner).toBe("tl");
    expect(setup.sizePct).toBe(33);
    expect(setup.camOpacity).toBe(70);
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

  it("saída que sumiu cai em '' (SEGUIR a padrão do Windows) e reporta — porque sysOn", () => {
    // O default deixou de ser `outputs[0]` de propósito: fixar a padrão do
    // momento da lista era o bug dos takes mudos de 2026-07-19 (o som muda de
    // saída depois — fone BT conecta — e o loopback fica no endpoint parado,
    // gravando silêncio sem erro). "" = o Rust resolve a padrão AO GRAVAR.
    const list: DeviceList = { ...FULL, outputs: [dev("Alto-falantes")] };
    const { setup, dropped } = reconcileSetup(SAVED, list);
    expect(setup.output).toBe("");
    expect(dropped).toEqual([{ kind: "output", label: "Fone BT" }]);
  });

  it("saída sumida NÃO é reportada quando o áudio do sistema está desligado", () => {
    // Sem sysOn a saída nem entra na gravação: avisar seria ruído.
    const saved: Setup = { ...SAVED, sysOn: false };
    const list: DeviceList = { ...FULL, outputs: [dev("Alto-falantes")] };
    const { setup, dropped } = reconcileSetup(saved, list);
    expect(setup.output).toBe(""); // ainda cai no default, sem device fantasma
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
    expect(setup.output).toBe("");
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

  it("camOpacity fora da faixa é clampado; lixo cai no default OPACO", () => {
    expect(reconcileSetup({ ...SAVED, camOpacity: 500 }, FULL).setup.camOpacity).toBe(OPACITY_MAX);
    // O piso não é 0: câmera invisível é indistinguível de câmera esquecida.
    expect(reconcileSetup({ ...SAVED, camOpacity: 0 }, FULL).setup.camOpacity).toBe(OPACITY_MIN);
    // O default tem que ser 100 (opaco): quem nunca mexeu no slider não pode
    // ganhar uma câmera meio transparente por causa de um storage corrompido.
    expect(DEFAULT_SETUP.camOpacity).toBe(100);
    for (const lixo of [NaN, Infinity, "meio" as unknown as number, undefined]) {
      expect(reconcileSetup({ ...SAVED, camOpacity: lixo }, FULL).setup.camOpacity).toBe(
        DEFAULT_SETUP.camOpacity,
      );
    }
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
    expect(setup.camOpacity).toBe(100);
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

describe("saída padrão (o conserto dos takes mudos)", () => {
  it("escolha explícita do usuário sobrevive; sem escolha, '' (seguir o Windows)", () => {
    // Explícita: "Fone BT" existe → fica.
    expect(reconcileSetup(SAVED, FULL).setup.output).toBe("Fone BT");
    // Primeira execução: NÃO cai em outputs[0] — "" deixa o Rust resolver a
    // padrão na hora de capturar, que é onde o som realmente está.
    expect(reconcileSetup(null, FULL).setup.output).toBe("");
  });
});

describe("filtro de ruído do microfone", () => {
  it("restaura o que foi salvo e o default é DESLIGADO", () => {
    expect(reconcileSetup(SAVED, FULL).setup.micFilter).toBe(true);
    expect(reconcileSetup(null, FULL).setup.micFilter).toBe(false);
    // Lixo no storage não liga filtro por acidente (só `true` literal liga).
    const lixo = { ...SAVED, micFilter: "yes" } as unknown as Setup;
    expect(reconcileSetup(lixo, FULL).setup.micFilter).toBe(false);
  });
});

describe("alvo de fps", () => {
  it("restaura o que foi salvo", () => {
    expect(reconcileSetup(SAVED, FULL).setup.fps).toBe(60);
  });

  it("valor fora da lista cai no default (lista fechada, não faixa)", () => {
    // Um fps arbitrário vindo de storage corrompido iria direto pro ffmpeg E
    // pra escolha do modo da câmera — 1000 fps não descartaria modo nenhum.
    for (const ruim of [45, 0, -30, 999, NaN]) {
      // `as Setup` de propósito: o ponto do teste é justamente o valor que o
      // TIPO proíbe mas o localStorage entrega.
      const corrompido = { ...SAVED, fps: ruim } as unknown as Setup;
      expect(reconcileSetup(corrompido, FULL).setup.fps).toBe(DEFAULT_SETUP.fps);
    }
  });
});

describe("fundo virtual da câmera", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("o default é 'none' — quem nunca mexeu não paga CPU nem muda o take", () => {
    const r = reconcileSetup(null, FULL).setup;
    expect(r.camBg).toBe("none");
    expect(r.camBgImage).toBe("");
  });

  it("restaura desfoque e imagem", () => {
    expect(reconcileSetup({ ...SAVED, camBg: "blur" } as unknown as Setup, FULL).setup.camBg).toBe("blur");
    const comFoto = { ...SAVED, camBg: "image", camBgImage: PNG } as unknown as Setup;
    const r = reconcileSetup(comFoto, FULL).setup;
    expect(r.camBg).toBe("image");
    expect(r.camBgImage).toBe(PNG);
  });

  it("modo corrompido cai em 'none'", () => {
    for (const ruim of ["greenscreen", 3, null, ""]) {
      const c = { ...SAVED, camBg: ruim } as unknown as Setup;
      expect(reconcileSetup(c, FULL).setup.camBg).toBe("none");
    }
  });

  // O caso que a tarefa mandou pensar (o "device que sumiu" aplicado ao fundo):
  // o modo pede imagem e a imagem não está utilizável.
  it("'image' sem imagem válida cai pra 'none', e não pra 'blur'", () => {
    const semFoto = { ...SAVED, camBg: "image", camBgImage: "" } as unknown as Setup;
    expect(reconcileSetup(semFoto, FULL).setup.camBg).toBe("none");

    const urlRemota = { ...SAVED, camBg: "image", camBgImage: "https://exemplo.com/f.png" } as unknown as Setup;
    const r = reconcileSetup(urlRemota, FULL).setup;
    expect(r.camBg).toBe("none");
    // E a URL recusada não sobrevive no setup aplicado.
    expect(r.camBgImage).toBe("");
  });

  it("desfoque sobrevive sem imagem nenhuma", () => {
    const c = { ...SAVED, camBg: "blur", camBgImage: "" } as unknown as Setup;
    expect(reconcileSetup(c, FULL).setup.camBg).toBe("blur");
  });
});
