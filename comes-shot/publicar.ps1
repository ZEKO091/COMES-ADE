# Publica una versión de Comes Shot en su servidor de actualizaciones de
# Cloudflare (Worker "comes-shot-updates"). Las copias instaladas la descargan
# y se actualizan solas.
#
#   Publicar:            sube `version` en Cargo.toml y ejecuta
#                        powershell -ExecutionPolicy Bypass -File publicar.ps1
#   Publicar poco a poco: ... -File publicar.ps1 -Rollout 20     (20 % de las copias)
#   Ampliar al 100 %:     ... -File publicar.ps1 -Rollout 100    (misma versión)
#   Pausar una versión:   ... -File publicar.ps1 -Pausar
#   Reanudarla:           ... -File publicar.ps1 -Reanudar

param(
    [ValidateRange(0, 100)][int]$Rollout = 100,
    [switch]$Pausar,
    [switch]$Reanudar
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$public = Join-Path $PSScriptRoot 'updates\public'
$manifestPath = Join-Path $public 'manifest.json'
$baseUrl = 'https://comes-shot-updates.kingfrianfrian16.workers.dev'

function Deploy {
    Push-Location (Join-Path $PSScriptRoot 'updates')
    try {
        npx --yes wrangler@4 deploy
        if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy falló.' }
    } finally { Pop-Location }
}

function Write-Manifest($m) {
    $json = $m | ConvertTo-Json
    [IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding $false))
}

$version = (Select-String -Path Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$current = $null
if (Test-Path $manifestPath) { $current = Get-Content $manifestPath -Raw | ConvertFrom-Json }

# Pause / resume / change rollout of the version already published.
if ($Pausar -or $Reanudar -or ($current -and $current.version -eq $version)) {
    if (-not $current) { throw 'Todavía no hay ninguna versión publicada.' }
    $current.paused = [bool]$Pausar
    $current.rollout = $Rollout
    Write-Manifest $current
    Deploy
    $state = if ($current.paused) { 'PAUSADA' } else { "activa para el $Rollout %" }
    Write-Host "Comes Shot $($current.version): $state."
    exit 0
}

Write-Host "Publicando Comes Shot $version"
cargo test --release
if ($LASTEXITCODE -ne 0) { throw 'Los tests fallaron; no se publica nada.' }
cargo build --release
if ($LASTEXITCODE -ne 0) { throw 'La compilación falló; no se publica nada.' }

$releases = Join-Path $public 'releases'
New-Item -ItemType Directory -Force $releases | Out-Null
$file = "ComesShot-$version.exe"
Copy-Item target\release\ComesShot.exe (Join-Path $releases $file) -Force
Copy-Item target\release\ComesShot.exe (Join-Path $public 'ComesShot.exe') -Force
$hash = (Get-FileHash (Join-Path $releases $file) -Algorithm SHA256).Hash.ToLower()

# Keep the three newest releases online (enough to roll back).
Get-ChildItem $releases -Filter 'ComesShot-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item

Write-Manifest ([ordered]@{
    version   = $version
    path      = "/releases/$file"
    sha256    = $hash
    paused    = $false
    rollout   = $Rollout
    published = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
})
Deploy

# Check what installs will actually see.
# (A just-created Worker can take a few seconds to answer: error 1042.)
$live = $null
foreach ($i in 1..12) {
    try {
        $live = Invoke-RestMethod "$baseUrl/manifest.json" -Headers @{ 'Cache-Control' = 'no-cache' }
        if ($live.version -eq $version -and $live.sha256 -eq $hash) { break }
    } catch { }
    Start-Sleep 5
}
if ($live.version -ne $version -or $live.sha256 -ne $hash) { throw "El servidor no muestra la versión nueva todavía." }
Write-Host "Publicada Comes Shot $version para el $Rollout % (SHA-256 $hash)."
Write-Host "Descarga directa: $baseUrl/ComesShot.exe"
