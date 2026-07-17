# Baixa o ffmpeg (Windows x64, build GPL completo do BtbN) e instala
# ffmpeg.exe + ffprobe.exe em src-tauri/binaries/ffmpeg.
# Build GPL de propósito: mais codecs/filtros, e copyleft não é problema na
# suíte (decisão 2026-07-13) — o binário roda como processo separado.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$ffDir = Join-Path $root "src-tauri\binaries\ffmpeg"
New-Item -ItemType Directory -Force -Path $ffDir | Out-Null

if ((Test-Path (Join-Path $ffDir "ffmpeg.exe")) -and (Test-Path (Join-Path $ffDir "ffprobe.exe"))) {
    Write-Host "ffmpeg já existe em $ffDir"
    exit 0
}

# A release "latest" do BtbN é um autobuild com link estável.
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
Write-Host "Baixando $url ..."
$zip = Join-Path $env:TEMP "ffmpeg-win64-gpl.zip"
Invoke-WebRequest -Uri $url -OutFile $zip

$extract = Join-Path $env:TEMP "ffmpeg-extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force
Remove-Item $zip -Force

foreach ($bin in "ffmpeg.exe", "ffprobe.exe") {
    $hit = Get-ChildItem -Path $extract -Recurse -Filter $bin | Select-Object -First 1
    if (-not $hit) { throw "$bin não encontrado dentro do zip" }
    Copy-Item $hit.FullName -Destination (Join-Path $ffDir $bin) -Force
}
Remove-Item $extract -Recurse -Force
Write-Host "Instalado em $ffDir"
