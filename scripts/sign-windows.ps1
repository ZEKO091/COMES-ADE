[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

$signingThumbprint = if ($null -eq $env:WINDOWS_SIGNING_CERT_THUMBPRINT) { '' } else { $env:WINDOWS_SIGNING_CERT_THUMBPRINT.Replace(' ', '').Trim() }
if ([string]::IsNullOrWhiteSpace($signingThumbprint)) {
  throw 'Falta WINDOWS_SIGNING_CERT_THUMBPRINT. No se permite crear un build firmado sin un certificado real.'
}
if ($signingThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
  throw 'WINDOWS_SIGNING_CERT_THUMBPRINT debe ser la huella SHA-1 de 40 caracteres del certificado.'
}

$timestampUrl = $env:WINDOWS_SIGNING_TIMESTAMP_URL
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
  # Este signtool del Windows SDK acepta el endpoint RFC 3161 de DigiCert
  # por HTTP; la respuesta sigue estando firmada por la TSA y se verifica
  # con signtool antes de continuar.
  $timestampUrl = 'http://timestamp.digicert.com'
}
if ($timestampUrl -notmatch '^https?://') {
  throw 'WINDOWS_SIGNING_TIMESTAMP_URL debe usar una URL HTTP(S) válida.'
}

$resolvedFile = Get-Item -LiteralPath ($FilePath.Trim().Trim('"')) -ErrorAction Stop
if ($resolvedFile.PSIsContainer) {
  throw 'La ruta de firma debe apuntar a un archivo.'
}
if ($resolvedFile.Extension.ToLowerInvariant() -notin @('.exe', '.msi', '.dll', '.tmp')) {
  throw "Tipo de artefacto no permitido para firma: $($resolvedFile.Extension)"
}

function Find-SignTool {
  if (-not [string]::IsNullOrWhiteSpace($env:TAURI_WINDOWS_SIGNTOOL_PATH)) {
    $configured = Get-Item -LiteralPath $env:TAURI_WINDOWS_SIGNTOOL_PATH -ErrorAction Stop
    return $configured.FullName
  }

  $fromPath = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
  if ($null -ne $fromPath) {
    return $fromPath.Path
  }

  $kitRoots = @()
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    $kitRoots += Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  }
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $kitRoots += Join-Path $env:ProgramFiles 'Windows Kits\10\bin'
  }
  $kitRoots = $kitRoots | Where-Object { Test-Path -LiteralPath $_ }

  $candidate = $kitRoots |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'signtool.exe' -File -Recurse -ErrorAction SilentlyContinue } |
    Where-Object { $_.FullName -match '\\(x64|arm64)\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($null -eq $candidate) {
    throw 'No se encontró signtool.exe. Instala el Windows SDK o define TAURI_WINDOWS_SIGNTOOL_PATH.'
  }
  return $candidate.FullName
}

$signTool = Find-SignTool
$arguments = @(
  'sign',
  '/fd', 'SHA256',
  '/sha1', $signingThumbprint,
  '/tr', $timestampUrl,
  '/td', 'SHA256',
  $resolvedFile.FullName
)

& $signTool @arguments
if ($LASTEXITCODE -ne 0) {
  throw "signtool no pudo firmar $($resolvedFile.Name)."
}

$verification = & $signTool verify /pa /all $resolvedFile.FullName 2>&1
if ($LASTEXITCODE -ne 0) {
  $verification | Out-Host
  throw "La firma Authenticode no pudo verificarse para $($resolvedFile.Name)."
}

Write-Output "Firma Authenticode verificada: $($resolvedFile.Name)"
