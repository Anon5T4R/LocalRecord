import { create } from "zustand";

import { loadSections, saveSections, toggled, type SectionState } from "../lib/sections";

export type Theme =
  | "light"
  | "dark"
  | "system"
  | "nature"
  | "darkblue"
  | "calmgreen"
  | "pastelpink"
  | "punkprincess";

export interface Toast {
  id: number;
  kind: "info" | "error" | "ok";
  text: string;
}

interface UiState {
  theme: Theme;
  settingsOpen: boolean;
  toasts: Toast[];
  /**
   * Quais cards o usuário recolheu/abriu (padrão B9 da suíte).
   *
   * Só o que ele MEXEU entra aqui — ausente = "ainda não opinou", e aí vale o
   * padrão do card (aberto quando o ajuste está fora do neutro). PERSISTE:
   * quem já configurou as fontes fecha aquele card uma vez e não quer
   * reabri-lo a cada gravação. A regra e a leitura/gravação moram em
   * `lib/sections.ts`, cópia literal do LocalVideo (o piloto do padrão).
   */
  sections: SectionState;

  setTheme: (t: Theme) => void;
  toggleSection: (id: string, open: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  pushToast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
}

const THEME_KEY = "localrecord.theme";
const SECTIONS_KEY = "localrecord.sections";

export const THEMES: Theme[] = [
  "system",
  "light",
  "dark",
  "nature",
  "darkblue",
  "calmgreen",
  "pastelpink",
  "punkprincess",
];

function loadTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v && (THEMES as string[]).includes(v) ? (v as Theme) : "system";
}

/** Aplica o tema no <html data-theme> (resolvendo "system" pela mídia). */
export function applyTheme(theme: Theme) {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.dataset.theme = resolved;
}

let nextToast = 1;

export const useUi = create<UiState>((set) => ({
  theme: loadTheme(),
  settingsOpen: false,
  toasts: [],
  sections: loadSections(SECTIONS_KEY),

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleSection: (id, open) =>
    set((s) => {
      const sections = toggled(s.sections, id, open);
      saveSections(SECTIONS_KEY, sections);
      return { sections };
    }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  pushToast: (kind, text) =>
    set((s) => ({ toasts: [...s.toasts, { id: nextToast++, kind, text }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
