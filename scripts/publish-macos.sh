#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script debe ejecutarse en macOS para publicar el instalador .dmg." >&2
  exit 2
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$project_root/releases"
mkdir -p "$release_dir"

shopt -s nullglob
dmgs=(
  "$project_root"/src-tauri/target/*/release/bundle/dmg/*.dmg
  "$project_root"/src-tauri/target/release/bundle/dmg/*.dmg
)

if (( ${#dmgs[@]} == 0 )); then
  echo "No se encontró ningún DMG. Ejecuta primero: npm run build:macos:updater" >&2
  exit 1
fi

published=0
for dmg in "${dmgs[@]}"; do
  base="$(basename "$dmg")"
  lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower" == *aarch64* || "$lower" == *arm64* ]]; then
    stable="ComesADE-Setup-arm64.dmg"
  elif [[ "$lower" == *x86_64* || "$lower" == *x64* ]]; then
    stable="ComesADE-Setup-x64.dmg"
  else
    # Default Apple Silicon naming when Tauri omits the arch suffix.
    stable="ComesADE-Setup-arm64.dmg"
  fi
  cp -f "$dmg" "$release_dir/$stable"
  cp -f "$dmg" "$release_dir/$base"
  echo "Instalador Mac publicado: $release_dir/$stable"
  published=$((published + 1))
done

if (( published == 0 )); then
  echo "No se publicó ningún instalador Mac." >&2
  exit 1
fi

echo "Listo. Sube los .dmg de releases/ a GitHub Releases (o usa el workflow Signed desktop builds con un tag v*)."
