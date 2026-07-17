import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, pickDefault, type Device } from "../sources";

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
