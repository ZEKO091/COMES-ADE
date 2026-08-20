param(
  [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseExe = Join-Path $projectRoot 'src-tauri\target\release\comesade.exe'
$bundleDirectory = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis'
$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$releaseDirectory = Join-Path $projectRoot 'releases'
$stableInstaller = Join-Path $releaseDirectory 'ComesADE-Setup.exe'

if ([string]::IsNullOrWhiteSpace($desktopDirectory)) {
  $oneDriveDesktop = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
  $desktopDirectory = if (Test-Path -LiteralPath $oneDriveDesktop -PathType Container) {
    $oneDriveDesktop
  } else {
    Join-Path $env:USERPROFILE 'Desktop'
  }
}

$desktopLauncher = Join-Path $desktopDirectory 'ComesADE.exe'

if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) {
  throw "No existe el build de ComesADE: $releaseExe. Ejecuta npm run tauri build primero."
}

$installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter 'ComesADE_*_x64-setup.exe' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($null -eq $installer) {
  throw "No se encontró el instalador NSIS en $bundleDirectory. Ejecuta npm run build:windows:signed primero."
}

function Assert-ValidAuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid') {
    throw "El artefacto no tiene una firma Authenticode válida: $Path ($($signature.Status)). Ejecuta npm run build:windows:signed."
  }
}

if ($RequireSignature) {
  Assert-ValidAuthenticodeSignature -Path $releaseExe
  Assert-ValidAuthenticodeSignature -Path $installer.FullName
} else {
  Write-Warning 'Publicación local sin firma Authenticode. Windows puede mostrar SmartScreen; usa publish:desktop:signed para distribución firmada.'
}

$running = Get-Process -Name 'comesade' -ErrorAction SilentlyContinue
if ($null -ne $running) {
  throw 'Cierra ComesADE antes de actualizarlo. No se creará una copia alternativa.'
}

New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
Copy-Item -LiteralPath $releaseExe -Destination $desktopLauncher -Force
Copy-Item -LiteralPath $installer.FullName -Destination $stableInstaller -Force

Write-Output "Launcher estable actualizado: $desktopLauncher"
Write-Output "Instalador estable actualizado: $stableInstaller"
Write-Output 'El Escritorio conserva un solo launcher; las próximas versiones reemplazan estos mismos archivos.'
