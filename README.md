# LocalRecord

Estúdio de captura de tela **100% offline** da suíte Local — grave a tela com a
câmera no canto e **anote AO VIVO** por cima. Sem live, sem nuvem, sem conta.

## Recursos

**v0.1 — onda 1 (feito)**
- Fontes de captura detectadas: tela, câmera e microfone (dshow no Windows,
  v4l2 no Linux)
- Runtime de mídia (ffmpeg) embutido, com aviso na UI se faltar
- Tema claro/escuro/sistema + 5 temas nomeados · UI em **PT/EN/ES**

**Em construção**
- **Onda 2:** motor de gravação — start/stop **gracioso** (o ffmpeg recebe `q`
  no stdin, nunca `kill`, senão o arquivo fica sem índice), gravação em **MKV**
  (recuperável) com **remux pra MP4** no fim (`-c copy`, sem recodificar),
  progresso ao vivo e preview WYSIWYG
- **Onda 3 (o pilar):** anotação **ao vivo** — janela transparente always-on-top
  sobre a tela, com caneta/texto/borracha. Como a captura pega o que está *na
  tela*, a anotação entra no vídeo de graça **e a plateia presencial vê junto**
  (trade-off aceito: fica queimada no vídeo)

## Stack

Tauri 2 + React 19 + Vite + TS; Rust no back só resolve o binário e move bytes —
os argumentos de cada job do ffmpeg se montam no front (TS puro, unit-testado).
Sem rede, sem telemetria.

## Dev

```bash
npm install

# Baixa o ffmpeg + ffprobe pra src-tauri/binaries/ffmpeg (passo MANUAL, uma vez;
# os binários não são versionados). No CI isso roda sozinho no release.yml.
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1   # Windows
bash scripts/fetch-ffmpeg.sh                                        # Linux

npm run tauri dev   # porta 1478
```

Sem esse passo o app abre normal e mostra a faixa de aviso — só não grava.

## Release

Tag `vX.Y.Z` → GitHub Actions builda NSIS (Windows) + AppImage (Linux), baixa o
ffmpeg e publica a Release. Parte da suíte [Local](https://github.com/Anon5T4R).

## Licença

MIT
