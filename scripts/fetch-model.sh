#!/usr/bin/env bash
# Baixa o modelo de segmentação da webcam (fundo virtual da câmera) e instala em
# public/models — de onde o vite o copia pro dist e o webview o carrega.
# Par do fetch-model.ps1: MESMO asset, MESMO sha256 (é um .onnx, não tem sabor
# por plataforma).
# Uso: bash scripts/fetch-model.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# MediaPipe Selfie Segmentation (o modelo que Meet/Zoom usam pra este efeito),
# na conversão ONNX da onnx-community. Apache-2.0, 462 KB, entrada 256x256.
#
# POR QUE ESTE e não o isnet do LocalPaint: o isnet leva SEGUNDOS por imagem — é
# pra foto parada. Aqui o orçamento é 33 ms (um quadro a 30 fps) e o spike mediu
# ~13,7 ms por quadro neste modelo, com o encoder gravando ao lado sem perder um
# quadro sequer.
#
# 462 KB entram no instalador em vez de virar download sob demanda (o padrão do
# LocalPaint, que carrega 170 MB): abaixo de 1 MB, a máquina de download com
# verificação, progresso e estado "modelo ausente" custaria mais código e mais
# modos de falha do que o próprio arquivo pesa.
# ---------------------------------------------------------------------------
MODEL_ASSET="mediapipe-selfie-segmentation.onnx"
MODEL_SHA256="3241ac4ad8aa35bdaf33946776db29f7c283a413aa0b0dacb9483594b4531aad"

root="$(cd "$(dirname "$0")/.." && pwd)"
model_dir="$root/public/models"
mkdir -p "$model_dir"
dest="$model_dir/$MODEL_ASSET"

if [ -f "$dest" ]; then
  echo "modelo já existe em $dest"
  exit 0
fi

url="https://github.com/Anon5T4R/Local-runtimes/releases/download/v1/$MODEL_ASSET"
echo "Baixando $url ..."
tmp="$(mktemp -d)/$MODEL_ASSET"
curl -fsSL "$url" -o "$tmp"

# Confere ANTES de instalar: modelo adulterado não chega em public/.
got="$(sha256sum "$tmp" | cut -d' ' -f1)"
if [ "$got" != "$MODEL_SHA256" ]; then
  rm -f "$tmp"
  echo "SHA256 NÃO BATE!" >&2
  echo "  esperado: $MODEL_SHA256" >&2
  echo "  recebido: $got" >&2
  echo "Download corrompido ou adulterado. Nada foi instalado." >&2
  exit 1
fi
echo "sha256 conferido: $got"

mv "$tmp" "$dest"
echo "Instalado em $dest"
