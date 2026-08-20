[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$thumbprint = if ($null -eq $env:WINDOWS_SIGNING_CERT_THUMBPRINT) { '' } else { $env:WINDOWS_SIGNING_CERT_THUMBPRINT.Replace(' ', '').Trim() }
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  throw 'Define WINDOWS_SIGNING_CERT_THUMBPRINT antes de crear el build firmado.'
}

$certificate = Get-ChildItem -Path 'Cert:\CurrentUser\My' -ErrorAction Stop |
  Where-Object { $_.Thumbprint -eq $thumbprint -and $_.HasPrivateKey } |
  Select-Object -First 1
if ($null -eq $certificate) {
  throw 'El certificado no está instalado en Cert:\CurrentUser\My o no tiene clave privada.'
}

& npm run tauri build -- --config src-tauri/tauri.windows.signed.conf.json
if ($LASTEXITCODE -eq 0) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $releaseExe = Join-Path $projectRoot 'src-tauri\target\release\comesade.exe'
  if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) {
    throw "No existe el ejecutable final para firmar: $releaseExe"
  }

  & (Join-Path $PSScriptRoot 'sign-windows.ps1') -FilePath $releaseExe
}
if ($LASTEXITCODE -ne 0) {
  throw 'El build firmado de Windows terminó con errores.'
}
