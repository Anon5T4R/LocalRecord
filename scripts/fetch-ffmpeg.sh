#!/usr/bin/env bash
# Baixa o ffmpeg (Linux x64, build estático do johnvansickle — roda em
# qualquer glibc) e instala ffmpeg + ffprobe em src-tauri/binaries/ffmpeg.
# Build GPL completo de propósito (copyleft OK na suíte, decisão 2026-07-13).
# Uso: bash scripts/fetch-ffmpeg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FF_DIR="$ROOT/src-tauri/binaries/ffmpeg"
mkdir -p "$FF_DIR"

if [ -f "$FF_DIR/ffmpeg" ] && [ -f "$FF_DIR/ffprobe" ]; then
  echo "ffmpeg já existe em $FF_DIR"
  exit 0
fi

URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
echo "Baixando $URL ..."
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o /tmp/ffmpeg-static.tar.xz

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
