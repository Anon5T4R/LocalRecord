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
FF_TAG="autobuild-2026-06-30-13-34"
FF_ASSET="ffmpeg-n8.1.2-21-gce3c09c101-linux64-gpl-8.1.tar.xz"
FF_SHA256="0ba73bbd93472c7622f6dec26d334c5e62e64d858d072490b2844320970456cd"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FF_DIR="$ROOT/src-tauri/binaries/ffmpeg"
mkdir -p "$FF_DIR"

if [ -f "$FF_DIR/ffmpeg" ] && [ -f "$FF_DIR/ffprobe" ]; then
  echo "ffmpeg já existe em $FF_DIR"
  exit 0
fi

URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/$FF_TAG/$FF_ASSET"
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
rm -rf /tmp/ffmpeg-static.tar.xz /tmp/ffmpeg-extract
echo "Instalado em $FF_DIR"
