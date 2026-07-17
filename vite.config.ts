import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Lição da suíte: uma única cópia do React (senão hooks quebram).
  resolve: {
    dedupe: ["react", "react-dom"],
  },

  // Duas páginas: a UI (`index.html`) e o overlay de anotação
  // (`annot.html`, a janela `annot`). Sem declarar as duas entradas aqui, o
  // build só emitiria a index e a janela do overlay abriria em branco NO
  // INSTALADOR — funcionando o tempo todo em `tauri dev`, que serve o projeto
  // inteiro pelo Vite. É o tipo de quebra que só aparece depois do release.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        annot: "annot.html",
      },
    },
  },

  // Opções do Vite ajustadas pro Tauri (só em `tauri dev`/`tauri build`).
  clearScreen: false,
  server: {
    // Porta única do LocalRecord na suíte (LocalMonitor=1476, este=1478). O
    // Tauri não tem fallback de porta — devUrl e esta porta têm que bater.
    port: 1478,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1479,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
