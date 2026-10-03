# Publica una versión de Comes Shot desde este PC (lo mismo que hace el
# workflow "Comes Shot release" en GitHub Actions).
#
#   1. Sube `version` en Cargo.toml.
#   2. Haz commit y push de comes-shot/ a main.
#   3. Ejecuta:  powershell -ExecutionPolicy Bypass -File publicar.ps1
#
# Crea la release "comes-shot-vX.Y.Z" con ComesShot.exe y su SHA-256. Nunca la
# marca como Latest y nunca usa tags v*, para no tocar ComesADE.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$tag = "comes-shot-v$version"
Write-Host "Comes Shot $version"

# "release not found" on stderr is the expected answer here; in Windows
# PowerShell 5.1 it would abort the script under 'Stop'.
$ErrorActionPreference = 'Continue'
gh release view $tag -R ZEKO091/COMES-ADE *> $null
$exists = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if ($exists) {
    Write-Host "$tag ya está publicada. Sube la versión en Cargo.toml para publicar otra."
    exit 0
}

cargo test --release
if ($LASTEXITCODE -ne 0) { throw 'Los tests fallaron; no se publica nada.' }
cargo build --release
if ($LASTEXITCODE -ne 0) { throw 'La compilación falló; no se publica nada.' }

$out = Join-Path $env:TEMP "comes-shot-$version"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item target\release\ComesShot.exe (Join-Path $out 'ComesShot.exe') -Force
$hash = (Get-FileHash (Join-Path $out 'ComesShot.exe') -Algorithm SHA256).Hash.ToLower()
Set-Content -Path (Join-Path $out 'ComesShot.exe.sha256') -Value $hash -NoNewline -Encoding ascii

gh release create $tag (Join-Path $out 'ComesShot.exe') (Join-Path $out 'ComesShot.exe.sha256') `
    -R ZEKO091/COMES-ADE `
    --target main `
    --title "Comes Shot $version" `
    --notes "Comes Shot $version para Windows. Las copias instaladas se actualizan solas." `
    --latest=false
if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear la release.' }
Write-Host "Publicada $tag (SHA-256 $hash). Las copias instaladas la recibirán en minutos."
