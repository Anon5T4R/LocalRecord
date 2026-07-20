#!/usr/bin/env bash
# Baixa o ffmpeg (Linux x64, build GPL do BtbN) e instala ffmpeg + ffprobe em
# src-tauri/binaries/ffmpeg. Build GPL completo de propósito (copyleft OK na
# suíte, decisão 2026-07-13 — o binário roda como processo separado).
#
# Fonte = BtbN, a MESMA do fetch-ffmpeg.ps1 (Windows): mesma build, mesmo sabor,
# um upstream só pra manter. Era johnvansickle.com até 2026-07-17, quando o CI
# começou a levar **HTTP 415** dele — o site responde 200 pra máquina de casa e
# bloqueia IP de datacenter (os runners do Actions). O BtbN mora no GitHub, que
# o Actions obviamente não bloqueia.
# Uso: bash scripts/fetch-ffmpeg.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# VERSÃO FIXA + SHA256 (2026-07-18) — ver o comentário longo no fetch-ffmpeg.ps1.
# Resumo: `latest` é tag ROLANTE (build diferente a cada dia, sem verificação
# nenhuma). Agora: tag fixa + sha256 conferido antes de extrair.
# `-gpl` (e não `-gpl-shared`): estático, sem arrastar .so pro AppImage.
# TAG DE FIM DE MES de proposito: o BtbN poda as diarias e so as mensais
# sobrevivem (ver o comentario longo no .ps1). Fixar numa diaria = 404 futuro.
# PRA ATUALIZAR: trocar as constantes aqui E no .ps1, sempre juntos.
# ---------------------------------------------------------------------------
# Tag do upstream de onde este binario veio (proveniencia; a URL usa o espelho).
FF_UPSTREAM_TAG="autobuild-2026-06-30-13-34"
FF_ASSET="ffmpeg-n8.1.2-21-gce3c09c101-linux64-gpl-8.1.tar.xz"
FF_SHA256="0ba73bbd93472c7622f6dec26d334c5e62e64d858d072490b2844320970456cd"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FF_DIR="$ROOT/src-tauri/binaries/ffmpeg"
mkdir -p "$FF_DIR"

# O guarda inclui LICENSE-ffmpeg.txt de propósito: quem já tinha os binários de
# antes da conformidade de licença (2026-07-20) precisa refazer o passo, senão o
# instalador sai sem o texto da GPL que a redistribuição exige.
if [ -f "$FF_DIR/ffmpeg" ] && [ -f "$FF_DIR/ffprobe" ] && [ -f "$FF_DIR/LICENSE-ffmpeg.txt" ]; then
  echo "ffmpeg já existe em $FF_DIR"
  exit 0
fi

URL="https://github.com/Anon5T4R/Local-runtimes/releases/download/v1/$FF_ASSET"
echo "Baixando $URL ..."
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o /tmp/ffmpeg-static.tar.xz

# Confere ANTES de extrair: binário adulterado não chega a ser descompactado.
GOT=$(sha256sum /tmp/ffmpeg-static.tar.xz | cut -d' ' -f1)
if [ "$GOT" != "$FF_SHA256" ]; then
  rm -f /tmp/ffmpeg-static.tar.xz
  echo "SHA256 NAO BATE!" >&2
  echo "  esperado: $FF_SHA256" >&2
  echo "  recebido: $GOT" >&2
  echo "Download corrompido ou adulterado. Nada foi instalado." >&2
  exit 1
fi
echo "sha256 conferido: $GOT"

rm -rf /tmp/ffmpeg-extract
mkdir -p /tmp/ffmpeg-extract
tar -xJf /tmp/ffmpeg-static.tar.xz -C /tmp/ffmpeg-extract

for bin in ffmpeg ffprobe; do
  HIT=$(find /tmp/ffmpeg-extract -type f -name "$bin" | head -1)
  [ -z "$HIT" ] && { echo "$bin não encontrado no tarball"; exit 1; }
  cp "$HIT" "$FF_DIR/$bin"
  chmod +x "$FF_DIR/$bin"
done

# ---------------------------------------------------------------------------
# CONFORMIDADE DE LICENÇA (2026-07-20)
#
# O ffmpeg é GPL-3.0-or-later e vai DENTRO do nosso instalador. Isso não
# contamina o código do app (ele roda como processo separado, invocado por
# linha de comando — é agregação, não linkagem), mas a redistribuição do
# binário obriga a acompanhar o texto da licença e a oferta de código-fonte.
#
# O tarball já traz o LICENSE.txt; copiamos ele em vez de versionar uma cópia
# nossa, pra o texto que sai no instalador ser exatamente o que veio com o
# binário. Os dois arquivos caem em binaries/ffmpeg/, que o
# `"resources": ["binaries/ffmpeg/*"]` do tauri.conf.json já empacota.
# ---------------------------------------------------------------------------
LIC=$(find /tmp/ffmpeg-extract -type f -name "LICENSE.txt" | head -1)
[ -z "$LIC" ] && { echo "LICENSE.txt não encontrado no tarball — não é possível redistribuir o ffmpeg sem ele"; exit 1; }
cp "$LIC" "$FF_DIR/LICENSE-ffmpeg.txt"

cat > "$FF_DIR/FONTE-FFMPEG.txt" <<EOF
FFmpeg — binário de terceiro redistribuído com o LocalRecord
============================================================

O ffmpeg/ffprobe que acompanha este instalador é uma build NÃO MODIFICADA de
terceiro, licenciada sob a GNU General Public License versão 3 ou posterior
(build "-gpl" do BtbN, configurada com --enable-gpl --enable-version3). O texto
completo da licença está em LICENSE-ffmpeg.txt, nesta mesma pasta.

O ffmpeg roda como PROCESSO SEPARADO, invocado por linha de comando. O código do
LocalRecord não faz linkagem com as bibliotecas do FFmpeg: as duas obras são
apenas agregadas no mesmo instalador e cada uma mantém a sua licença — o
LocalRecord é MIT, o FFmpeg é GPL-3.0-or-later.

Procedência exata desta cópia
-----------------------------
  build ............. $FF_ASSET
  tag do upstream ... $FF_UPSTREAM_TAG
  sha256 ............ $FF_SHA256
  espelho ........... https://github.com/Anon5T4R/Local-runtimes (release v1)
  receita de build .. https://github.com/BtbN/FFmpeg-Builds
  fonte do FFmpeg ... https://github.com/FFmpeg/FFmpeg

Oferta de código-fonte (GPL-3.0, seção 6)
-----------------------------------------
O código-fonte correspondente a esta build está publicamente disponível nos
endereços acima. O commit exato do FFmpeg está no próprio nome do arquivo da
build: "n8.1.2-21-gce3c09c101" = tag n8.1.2, 21 commits à frente, commit
ce3c09c101. A receita de compilação é a do repositório BtbN/FFmpeg-Builds.

Se preferir receber o código-fonte por outro meio, abra uma issue em
https://github.com/Anon5T4R/LocalRecord e ele será fornecido.
EOF

rm -rf /tmp/ffmpeg-static.tar.xz /tmp/ffmpeg-extract
echo "Instalado em $FF_DIR (+ LICENSE-ffmpeg.txt e FONTE-FFMPEG.txt)"
