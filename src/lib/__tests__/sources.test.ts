import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  meterDb,
  meterPct,
  pickDefault,
  type Device,
} from "../sources";

const dev = (id: string): Device => ({ id, label: id });

describe("pickDefault", () => {
  it("mantém a escolha anterior se o dispositivo ainda existe", () => {
    const list = [dev("Camera A"), dev("Camera B")];
    expect(pickDefault(list, "Camera B")).toBe("Camera B");
  });

  it("cai no fallback quando o anterior sumiu (webcam desplugada)", () => {
    const list = [dev("primary")];
    expect(pickDefault(list, "monitor-2", "primary")).toBe("primary");
  });

  it("sem fallback, 'nenhum' é seleção válida (câmera/mic são opcionais)", () => {
    expect(pickDefault([dev("Camera A")], "")).toBe("");
    expect(pickDefault([], "sumida")).toBe("");
  });
});

describe("formatDuration", () => {
  it("mm:ss abaixo de uma hora, h:mm:ss acima", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(83_000)).toBe("01:23");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("entrada inválida não vira NaN na tela", () => {
    expect(formatDuration(-1)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });
});

describe("medidor de nível", () => {
  it("a barra é em dB, não linear", () => {
    // Estourando = cheia; -60 dB (0,001 linear) = o fundo da escala.
    expect(meterPct(1)).toBe(100);
    expect(meterPct(0.001)).toBe(0);
    // O caso que justifica a escala: 0,1 linear é MUITO áudio (-20 dB) e numa
    // barra linear seria um risquinho de 10% que o usuário leria como "mudo".
    expect(Math.round(meterPct(0.1))).toBe(67);
    expect(Math.round(meterPct(0.5))).toBe(90);
  });

  it("silêncio é zero e nunca vira NaN/negativo na tela", () => {
    expect(meterPct(0)).toBe(0);
    expect(meterPct(-1)).toBe(0);
    expect(meterPct(Number.NaN)).toBe(0);
    // Pico acima de 1 (o mix do Windows é float) não estica a barra pra fora.
    expect(meterPct(2)).toBe(100);
  });

  it("o rótulo em dB não diz '-Infinity'", () => {
    expect(meterDb(0)).toBe("—");
    expect(meterDb(1)).toBe("0 dB");
    expect(meterDb(0.5)).toBe("-6 dB");
  });
});

describe("formatBytes", () => {
  it("sobe de unidade conforme o take cresce", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("gravação recém-começada mostra 0, não NaN", () => {
    // O ffmpeg manda `total_size=N/A` no primeiro bloco de progresso — vira 0.
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 MB");
  });
});
