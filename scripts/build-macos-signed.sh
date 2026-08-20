#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script debe ejecutarse en macOS; no intenta simular una firma Apple desde otro sistema." >&2
  exit 2
fi

: "${APPLE_SIGNING_IDENTITY:?Define APPLE_SIGNING_IDENTITY con una identidad Developer ID Application real.}"
if [[ "$APPLE_SIGNING_IDENTITY" != Developer\ ID\ Application:* ]]; then
  echo "APPLE_SIGNING_IDENTITY debe ser una identidad Developer ID Application." >&2
  exit 2
fi

if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
  : "${APPLE_API_KEY:?Falta APPLE_API_KEY para la autenticación de App Store Connect.}"
  : "${APPLE_API_ISSUER:?Falta APPLE_API_ISSUER para la autenticación de App Store Connect.}"
  : "${APPLE_API_KEY_PATH:?Falta APPLE_API_KEY_PATH para la clave privada de App Store Connect.}"
  [[ -f "$APPLE_API_KEY_PATH" ]] || { echo "No existe APPLE_API_KEY_PATH: $APPLE_API_KEY_PATH" >&2; exit 2; }
else
  : "${APPLE_ID:?Define APPLE_ID o usa las credenciales de App Store Connect.}"
  : "${APPLE_PASSWORD:?Falta APPLE_PASSWORD; usa una contraseña específica de app.}"
  : "${APPLE_TEAM_ID:?Falta APPLE_TEAM_ID.}"
fi

if ! security find-identity -v -p codesigning | grep -Fq "$APPLE_SIGNING_IDENTITY"; then
  echo "La identidad Apple no está instalada en el llavero de inicio de sesión." >&2
  exit 2
fi

target_args=()
if [[ -n "${TAURI_TARGET:-}" ]]; then
  target_args+=(--target "$TAURI_TARGET")
fi

npm run tauri build -- --bundles dmg "${target_args[@]}"

shopt -s nullglob
dmgs=(src-tauri/target/*/release/bundle/dmg/*.dmg src-tauri/target/release/bundle/dmg/*.dmg)
if (( ${#dmgs[@]} == 0 )); then
  echo 'No se encontró el DMG generado.' >&2
  exit 1
fi
for dmg in "${dmgs[@]}"; do
  xcrun stapler validate "$dmg"
done
