# Baixa o ffmpeg (Windows x64, build GPL completo do BtbN) e instala
# ffmpeg.exe + ffprobe.exe em src-tauri/binaries/ffmpeg.
# Build GPL de propósito: mais codecs/filtros, e copyleft não é problema na
# suíte (decisão 2026-07-13) — o binário roda como processo separado.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# VERSÃO FIXA + SHA256 (2026-07-18)
#
# Era a tag `latest` do BtbN, que é ROLANTE: o mesmo comando trazia um binário
# diferente a cada dia, e nada conferia o que chegou. Duas consequências reais:
# (1) build não reproduzível — a release de ontem e a de hoje embarcam ffmpeg
# diferentes sem registro de qual; (2) um binário de terceiro entrava no
# instalador SEM verificação nenhuma. É a única superfície de supply-chain da
# suíte, e o susto do antivírus (2026-07-18) deixou claro que ela merece porta.
#
# `n8.1.2` é build do branch de RELEASE (estável); `latest` apontava pro
# master, que muda todo dia por definição.
#
# ⚠️ POR QUE UMA TAG DE FIM DE MÊS, e não a mais recente: o BtbN mantém só ~38
# releases. As recentes são DIÁRIAS e vão sendo podadas; o que sobrevive a longo
# prazo é a do ÚLTIMO DIA DE CADA MÊS (há tags mensais desde 2024-08). Fixar numa
# diária é fixar numa versão com prazo de validade — quando ela some, o build
# quebra com 404 em todo app que a usa. Aconteceu de eu fixar numa diária nesta
# mesma passada e ter que corrigir.
#
# PRA ATUALIZAR: escolher outra tag de FIM DE MÊS em
# github.com/BtbN/FFmpeg-Builds/releases, baixar os dois artefatos, rodar
# `sha256sum` e trocar as constantes aqui e no par (.ps1/.sh). Nunca `latest`,
# nunca uma diária.
# ---------------------------------------------------------------------------
# Tag do upstream de onde este binario veio (proveniencia; a URL usa o espelho).
$ffUpstreamTag = "autobuild-2026-06-30-13-34"
$ffAsset = "ffmpeg-n8.1.2-21-gce3c09c101-win64-gpl-8.1.zip"
$ffSha256 = "682361e32c9631caec09e5d9f09077101c9ed90c14e275f62014fefa6d397990"

$root = Split-Path -Parent $PSScriptRoot
$ffDir = Join-Path $root "src-tauri\binaries\ffmpeg"
New-Item -ItemType Directory -Force -Path $ffDir | Out-Null

# O guarda inclui LICENSE-ffmpeg.txt de propósito: quem já tinha os binários de
# antes da conformidade de licença (2026-07-20) precisa refazer o passo, senão o
# instalador sai sem o texto da GPL que a redistribuição exige.
if ((Test-Path (Join-Path $ffDir "ffmpeg.exe")) -and (Test-Path (Join-Path $ffDir "ffprobe.exe")) -and (Test-Path (Join-Path $ffDir "LICENSE-ffmpeg.txt"))) {
    Write-Host "ffmpeg já existe em $ffDir"
    exit 0
}

$url = "https://github.com/Anon5T4R/Local-runtimes/releases/download/v1/$ffAsset"
Write-Host "Baixando $url ..."
$zip = Join-Path $env:TEMP "ffmpeg-win64-gpl.zip"
Invoke-WebRequest -Uri $url -OutFile $zip

# Confere ANTES de extrair: binário adulterado não chega a ser descompactado.
$got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $ffSha256) {
    Remove-Item $zip -Force
    throw "SHA256 NAO BATE!`n  esperado: $ffSha256`n  recebido: $got`nDownload corrompido ou adulterado. Nada foi instalado."
}
Write-Host "sha256 conferido: $got"

$extract = Join-Path $env:TEMP "ffmpeg-extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force
Remove-Item $zip -Force

foreach ($bin in "ffmpeg.exe", "ffprobe.exe") {
    $hit = Get-ChildItem -Path $extract -Recurse -Filter $bin | Select-Object -First 1
    if (-not $hit) { throw "$bin não encontrado dentro do zip" }
    Copy-Item $hit.FullName -Destination (Join-Path $ffDir $bin) -Force
}

# ---------------------------------------------------------------------------
# CONFORMIDADE DE LICENÇA (2026-07-20)
#
# O ffmpeg é GPL-3.0-or-later e vai DENTRO do nosso instalador. Isso não
# contamina o código do app (ele roda como processo separado, invocado por linha
# de comando — é agregação, não linkagem), mas a redistribuição do binário
# obriga a acompanhar o texto da licença e a oferta de código-fonte.
#
# O zip já traz o LICENSE.txt; copiamos ele em vez de versionar uma cópia nossa,
# pra o texto que sai no instalador ser exatamente o que veio com o binário. Os
# dois arquivos caem em binaries/ffmpeg/, que o
# `"resources": ["binaries/ffmpeg/*"]` do tauri.conf.json já empacota.
# ---------------------------------------------------------------------------
$lic = Get-ChildItem -Path $extract -Recurse -Filter "LICENSE.txt" | Select-Object -First 1
if (-not $lic) { throw "LICENSE.txt não encontrado dentro do zip — não é possível redistribuir o ffmpeg sem ele" }
Copy-Item $lic.FullName -Destination (Join-Path $ffDir "LICENSE-ffmpeg.txt") -Force

$fonte = @"
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
  build ............. $ffAsset
  tag do upstream ... $ffUpstreamTag
  sha256 ............ $ffSha256
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
"@
Set-Content -Path (Join-Path $ffDir "FONTE-FFMPEG.txt") -Value $fonte -Encoding UTF8

Remove-Item $extract -Recurse -Force
Write-Host "Instalado em $ffDir (+ LICENSE-ffmpeg.txt e FONTE-FFMPEG.txt)"
