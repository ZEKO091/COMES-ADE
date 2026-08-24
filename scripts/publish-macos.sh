#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script debe ejecutarse en macOS para publicar el .app." >&2
  exit 2
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$project_root/releases"
mkdir -p "$release_dir"

shopt -s nullglob
apps=(
  "$project_root"/src-tauri/target/*/release/bundle/macos/*.app
  "$project_root"/src-tauri/target/release/bundle/macos/*.app
)

if (( ${#apps[@]} == 0 )); then
  echo "No se encontró ningún .app. Ejecuta primero: npm run build:macos:updater" >&2
  exit 1
fi

published=0
for app in "${apps[@]}"; do
  base="$(basename "$app")"
  parent="$(basename "$(dirname "$(dirname "$(dirname "$app")")")")"
  lower="$(printf '%s' "$app" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower" == *aarch64* || "$lower" == *arm64* || "$parent" == *aarch64* ]]; then
    stable="ComesADE-arm64.app.zip"
  elif [[ "$lower" == *x86_64* || "$lower" == *x64* || "$parent" == *x86_64* ]]; then
    stable="ComesADE-x64.app.zip"
  else
    # Default Apple Silicon when Tauri omits the arch in the path.
    stable="ComesADE-arm64.app.zip"
  fi

  zip_path="$release_dir/$stable"
  rm -f "$zip_path"
  # Keep the .app bundle structure intact for Finder / Applications.
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip_path"
  echo "App Mac publicada: $zip_path (desde $base)"
  published=$((published + 1))
done

# Also keep updater tarballs if present (signed updates).
for tarball in \
  "$project_root"/src-tauri/target/*/release/bundle/macos/*.app.tar.gz \
  "$project_root"/src-tauri/target/release/bundle/macos/*.app.tar.gz
do
  [[ -f "$tarball" ]] || continue
  cp -f "$tarball" "$release_dir/$(basename "$tarball")"
  [[ -f "${tarball}.sig" ]] && cp -f "${tarball}.sig" "$release_dir/$(basename "$tarball").sig"
done

if (( published == 0 )); then
  echo "No se publicó ningún .app de Mac." >&2
  exit 1
fi

echo "Listo. Artefactos en releases/: ComesADE-arm64.app.zip / ComesADE-x64.app.zip (misma app que ComesADE-Setup.exe en Windows)."
