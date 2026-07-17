/** Fontes de captura: tipos do contrato com o Rust + helpers puros. */

export interface Device {
  id: string;
  label: string;
}

export interface DeviceList {
  screens: Device[];
  cameras: Device[];
  microphones: Device[];
}

/** Id sintético da tela principal (contrato provisório — ver devices.rs). */
export const PRIMARY_SCREEN = "primary";

/**
 * Escolhe o que deixar selecionado quando a lista chega.
 *
 * Regra: respeita a escolha anterior se o dispositivo ainda existir (o usuário
 * desplugar a webcam e replugar não pode zerar a seleção), senão cai no
 * `fallback` — `""` significa "nenhum", que é seleção válida pra câmera e mic.
 */
export function pickDefault(devices: Device[], previous: string, fallback = ""): string {
  if (previous && devices.some((d) => d.id === previous)) return previous;
  if (fallback && devices.some((d) => d.id === fallback)) return fallback;
  return devices.length > 0 && fallback !== "" ? devices[0].id : "";
}

/**
 * Duração "01:23" / "1:02:03" pro cronômetro da gravação (onda 2).
 *
 * Recebe MILISSEGUNDOS. Fica dito porque o `out_time_ms` do ffmpeg vem em
 * MICROSSEGUNDOS (gotcha #1 da suíte) — quem chama daqui já dividiu por 1000.
 */
/** Tamanho do arquivo crescendo durante a gravação ("1,2 GB").
 *  Base 1024 e uma casa decimal: o número serve pra dar NOÇÃO de quanto disco
 *  o take está comendo, não pra bater com o byte. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i <= 1 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
