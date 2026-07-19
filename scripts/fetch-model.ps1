# Baixa o modelo de segmentação da webcam (fundo virtual da câmera) e instala
# em public/models — de onde o vite o copia pro dist e o webview o carrega.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/fetch-model.ps1
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# MediaPipe Selfie Segmentation (o modelo que Meet/Zoom usam pra este efeito),
# na conversão ONNX da onnx-community. Apache-2.0, 462 KB, entrada 256x256.
#
# POR QUE ESTE e não o isnet do LocalPaint: o isnet leva SEGUNDOS por imagem —
# é pra foto parada. Aqui o orçamento é 33 ms (um quadro a 30 fps) e o spike
# mediu ~13,7 ms por quadro neste modelo, com o encoder gravando ao lado sem
# perder um quadro sequer.
#
# 462 KB entram no instalador em vez de virar download sob demanda (o padrão do
# LocalPaint, que carrega 170 MB): abaixo de 1 MB, a máquina de download com
# verificação, barra de progresso e estado "modelo ausente" custaria mais
# código e mais modos de falha do que o próprio arquivo pesa.
#
# PRA ATUALIZAR: baixar do upstream, rodar sha256sum, subir no espelho e trocar
# as constantes aqui e no par (.sh).
# ---------------------------------------------------------------------------
$modelAsset = "mediapipe-selfie-segmentation.onnx"
$modelSha256 = "3241ac4ad8aa35bdaf33946776db29f7c283a413aa0b0dacb9483594b4531aad"

$root = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $root "public\models"
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
$dest = Join-Path $modelDir $modelAsset

if (Test-Path $dest) {
    Write-Host "modelo ja existe em $dest"
    exit 0
}

$url = "https://github.com/Anon5T4R/Local-runtimes/releases/download/v1/$modelAsset"
Write-Host "Baixando $url ..."
$tmp = Join-Path $env:TEMP $modelAsset
Invoke-WebRequest -Uri $url -OutFile $tmp

# Confere ANTES de instalar: modelo adulterado nao chega em public/.
$got = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
if ($got -ne $modelSha256) {
    Remove-Item $tmp -Force
    throw "SHA256 NAO BATE!`n  esperado: $modelSha256`n  recebido: $got`nDownload corrompido ou adulterado. Nada foi instalado."
}
Write-Host "sha256 conferido: $got"

Move-Item $tmp $dest -Force
Write-Host "Instalado em $dest"
