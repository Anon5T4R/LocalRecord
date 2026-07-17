import { describe, expect, it } from "vitest";
import {
  buildRecordArgs,
  buildRemuxArgs,
  expandPattern,
  type RecordSpec,
} from "../args";

/** Base "só tela", o caso mais simples. Cada teste muda o que interessa. */
const base: RecordSpec = {
  platform: "windows",
  grabber: "ddagrab",
  fps: 30,
  camera: null,
  mic: null,
  encoder: "libx264",
  outPath: "C:/v/take.mkv",
};

describe("buildRecordArgs", () => {
  it("só tela (ddagrab): baixa o quadro da GPU e sai em MKV", () => {
    expect(buildRecordArgs(base)).toEqual([
      "-f", "lavfi", "-i", "ddagrab=output_idx=0:framerate=30",
      "-filter_complex", "[0:v]hwdownload,format=bgra[scr];[scr]format=yuv420p[v]",
      "-map", "[v]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-f", "matroska", "C:/v/take.mkv",
    ]);
  });

  it("tela + câmera num canto: overlay posicionado e câmera escalada pela tela", () => {
    const args = buildRecordArgs({
      ...base,
      camera: { id: "Integrated Camera", corner: "br", sizePct: 25 },
    });
    expect(args).toEqual([
      "-f", "lavfi", "-i", "ddagrab=output_idx=0:framerate=30",
      "-rtbufsize", "128M", "-f", "dshow", "-i", "video=Integrated Camera",
      "-filter_complex",
      "[0:v]hwdownload,format=bgra[scr];" +
        "[1:v][scr]scale2ref=w=iw*0.2500:h=ow/mdar[cam][scr2];" +
        "[scr2][cam]overlay=W-w-16:H-h-16,format=yuv420p[v]",
      "-map", "[v]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-f", "matroska", "C:/v/take.mkv",
    ]);
  });

  it("tela + câmera + mic: o mic é a entrada 2 e é dela que sai o áudio", () => {
    const args = buildRecordArgs({
      ...base,
      camera: { id: "Integrated Camera", corner: "tl", sizePct: 20 },
      mic: "Microfone (Realtek(R) Audio)",
    });
    expect(args).toEqual([
      "-f", "lavfi", "-i", "ddagrab=output_idx=0:framerate=30",
      "-rtbufsize", "128M", "-f", "dshow", "-i", "video=Integrated Camera",
      "-rtbufsize", "128M", "-f", "dshow", "-i", "audio=Microfone (Realtek(R) Audio)",
      "-filter_complex",
      "[0:v]hwdownload,format=bgra[scr];" +
        "[1:v][scr]scale2ref=w=iw*0.2000:h=ow/mdar[cam][scr2];" +
        "[scr2][cam]overlay=16:16,format=yuv420p[v]",
      "-map", "[v]",
      "-map", "2:a", "-c:a", "aac", "-b:a", "160k",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-f", "matroska", "C:/v/take.mkv",
    ]);
  });

  it("sem câmera, o mic vira a entrada 1 (o índice acompanha as fontes)", () => {
    // Regressão: se o índice do mic fosse fixo em 2, gravar "tela + mic" mapearia
    // uma entrada que não existe e o ffmpeg morreria na largada.
    const args = buildRecordArgs({ ...base, mic: "Mic" });
    expect(args).toContain("-map");
    expect(args.join(" ")).toContain("-map 1:a");
  });

  it("fallback gdigrab: entrada direta em CPU, sem hwdownload", () => {
    const args = buildRecordArgs({ ...base, grabber: "gdigrab" });
    expect(args).toEqual([
      "-f", "gdigrab", "-framerate", "30", "-i", "desktop",
      "-filter_complex", "[0:v]null[scr];[scr]format=yuv420p[v]",
      "-map", "[v]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-f", "matroska", "C:/v/take.mkv",
    ]);
    // O hwdownload é da DDA (quadro na GPU); no gdigrab ele quebraria o grafo.
    expect(args.join(" ")).not.toContain("hwdownload");
  });

  it("linux: x11grab + v4l2 + pulse, sem dshow", () => {
    const args = buildRecordArgs({
      ...base,
      platform: "linux",
      grabber: "x11grab",
      camera: { id: "/dev/video0", corner: "tr", sizePct: 25 },
      mic: "default",
    });
    const line = args.join(" ");
    expect(line).toContain("-f x11grab -framerate 30 -i :0.0");
    expect(line).toContain("-f v4l2 -i /dev/video0");
    expect(line).toContain("-f pulse -i default");
    expect(line).not.toContain("dshow");
    expect(line).not.toContain("rtbufsize");
  });

  it("cada canto tem sua expressão de overlay", () => {
    const corner = (c: "tl" | "tr" | "bl" | "br") =>
      buildRecordArgs({ ...base, camera: { id: "C", corner: c, sizePct: 25 } })
        .join(" ")
        .match(/overlay=([^,]+),/)![1];
    expect(corner("tl")).toBe("16:16");
    expect(corner("tr")).toBe("W-w-16:16");
    expect(corner("bl")).toBe("16:H-h-16");
    expect(corner("br")).toBe("W-w-16:H-h-16");
  });

  it("tamanho da câmera é limitado (0% ou 100% não são layout)", () => {
    const pct = (p: number) =>
      buildRecordArgs({ ...base, camera: { id: "C", corner: "br", sizePct: p } })
        .join(" ")
        .match(/w=iw\*([\d.]+):/)![1];
    expect(pct(0)).toBe("0.0500");
    expect(pct(999)).toBe("0.6000");
    expect(pct(25)).toBe("0.2500");
  });

  it("nenhuma gravação passa -nostdin (é por lá que o stop gracioso fala)", () => {
    // O `q` do rec_stop entra pelo stdin; -nostdin fecharia essa porta e o stop
    // só teria kill — que deixa o arquivo sem trailer.
    for (const g of ["ddagrab", "gdigrab", "x11grab"] as const) {
      expect(buildRecordArgs({ ...base, grabber: g })).not.toContain("-nostdin");
    }
  });

  it("os encoders de hardware têm o botão de qualidade da própria família", () => {
    expect(buildRecordArgs({ ...base, encoder: "h264_nvenc" }).join(" ")).toContain(
      "-c:v h264_nvenc -preset p4 -rc vbr -cq 23",
    );
    expect(buildRecordArgs({ ...base, encoder: "h264_qsv" }).join(" ")).toContain(
      "-c:v h264_qsv -global_quality 23",
    );
    expect(buildRecordArgs({ ...base, encoder: "h264_amf" }).join(" ")).toContain(
      "-c:v h264_amf -quality balanced -rc cqp -qp_i 23 -qp_p 23",
    );
    // -crf é do x264: passar pro nvenc seria opção desconhecida e erro na hora.
    expect(buildRecordArgs({ ...base, encoder: "h264_nvenc" })).not.toContain("-crf");
  });
});

describe("buildRemuxArgs", () => {
  it("remux é cópia de bytes — nunca re-encode", () => {
    expect(buildRemuxArgs("C:/v/take.mkv", "C:/v/take.mp4")).toEqual([
      "-i", "C:/v/take.mkv",
      "-map", "0", "-c", "copy",
      "-movflags", "+faststart",
      "-f", "mp4", "C:/v/take.mp4",
    ]);
  });
});

describe("expandPattern", () => {
  const now = new Date(2026, 6, 17, 9, 5, 3); // 17/07/2026 09:05:03

  it("troca os tokens por data e hora", () => {
    expect(expandPattern("gravacao-{date}-{time}", now)).toBe("gravacao-2026-07-17-09-05-03");
  });

  it("caractere proibido no Windows não chega no disco", () => {
    // Um ":" digitado no padrão quebraria a gravação inteira só no fim.
    expect(expandPattern("aula: parte 1/2", now)).toBe("aula- parte 1-2");
  });

  it("padrão vazio ainda dá um nome", () => {
    expect(expandPattern("", now)).toBe("gravacao");
    expect(expandPattern("   ", now)).toBe("gravacao");
  });
});
