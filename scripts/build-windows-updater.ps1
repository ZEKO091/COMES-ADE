[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

& npm run tauri build -- --config src-tauri/tauri.updater.conf.json
if ($LASTEXITCODE -ne 0) {
  throw 'El build del updater de Windows termino con errores.'
}
