# LocalRecord

Estúdio de captura de tela **100% offline** da suíte Local — grave a tela com a
câmera no canto e **anote AO VIVO** por cima. Sem live, sem nuvem, sem conta.

## Recursos

**v0.1 — onda 1 (feito)**
- Fontes de captura detectadas: tela, câmera e microfone (dshow no Windows,
  v4l2 no Linux)
- Runtime de mídia (ffmpeg) embutido, com aviso na UI se faltar
- Tema claro/escuro/sistema + 5 temas nomeados · UI em **PT/EN/ES**

**Áudio do sistema — WASAPI loopback (feito, Windows)**
- Grava **o que o computador está tocando** capturando o *loopback* da saída de
  áudio **no Rust** (WASAPI direto, em modo *polling*), não pelo `dshow` do
  ffmpeg. O PCM entra no ffmpeg por um **named pipe** próprio — o stdin fica
  reservado pro `q` do stop gracioso.
- **Medidores de nível (VU)** ao vivo pro microfone e pro áudio do sistema: dá
  pra ver o som entrando **antes** de gravar.
- Mic + sistema **mixados** por padrão, ou em **faixas separadas** (`-map`) pra
  equilibrar na edição.
- **Degrada com honestidade:** sem saída de áudio, ou se o loopback falhar, o
  app diz o motivo e grava sem o áudio do sistema — nunca grava mudo fingindo.
- **Linux:** pendente (o caminho é o monitor do PulseAudio/pipewire).

**Onda 2 — motor de gravação (feito, v0.3+)**
- Start/stop **gracioso** (o ffmpeg recebe `q` no stdin, nunca `kill`, senão o
  arquivo fica sem índice), gravação em **MKV** (recuperável) com **remux pra
  MP4** no fim (`-c copy`, sem recodificar), progresso ao vivo e escolha de
  encoder provada por teste real (não por lista `-encoders`).

**Onda 3 — anotação ao vivo, o pilar (feito, v0.4+)**
- Janela transparente always-on-top sobre a tela, com caneta/texto/borracha e
  atalhos globais (Ctrl+Shift+D caneta, Ctrl+Shift+X limpa). Como a captura
  pega o que está *na tela*, a anotação entra no vídeo de graça **e a plateia
  presencial vê junto** (trade-off aceito: fica queimada no vídeo).

**Câmera no canto (feito, v0.7)**
- A câmera é desenhada **na janela de anotação** (não como segunda captura do
  ffmpeg): duas capturas ao vivo no mesmo processo se estrangulavam (medido:
  47–116/300 frames). O ddagrab captura a tela com a câmera já composta —
  30 fps com e sem câmera, confirmado em máquina real.

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

## Créditos e licença

O código deste app é **MIT** (veja [LICENSE](LICENSE)).

O instalador embarca o **[FFmpeg](https://ffmpeg.org)** — build `-gpl` **não
modificada** do [BtbN](https://github.com/BtbN/FFmpeg-Builds), licenciada sob
**GPL-3.0-or-later** (compilada com `--enable-gpl --enable-version3`).

O FFmpeg roda como **processo separado**, invocado por linha de comando: o
código do LocalRecord não faz linkagem com as bibliotecas dele. As duas obras são
*agregadas* no mesmo instalador e cada uma mantém a sua licença — é por isso que
embarcar um binário GPL não torna o app GPL. O que a GPL exige aqui é sobre a
**distribuição do binário**, e é o que os arquivos `LICENSE-ffmpeg.txt` e
`FONTE-FFMPEG.txt` cumprem: texto integral da licença, procedência exata (tag do
upstream, sha256, espelho) e a oferta de código-fonte correspondente. Os dois são
gerados pelo `scripts/fetch-ffmpeg.*` a partir do próprio arquivo baixado e vão
dentro do instalador, ao lado do executável.

O modelo de segmentação da câmera (MediaPipe Selfie Segmentation, conversão ONNX
da onnx-community) é **Apache-2.0** e também vai embarcado, sem modificação.
