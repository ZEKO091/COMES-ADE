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
    # Native Tauri builds omit the architecture from the bundle path.
    case "$(uname -m)" in
      arm64|aarch64) stable="ComesADE-arm64.app.zip" ;;
      x86_64|amd64) stable="ComesADE-x64.app.zip" ;;
      *)
        echo "No se pudo detectar la arquitectura de macOS: $(uname -m)" >&2
        exit 1
        ;;
    esac
  fi

  zip_path="$release_dir/$stable"
  rm -f "$zip_path"
  # Keep the .app bundle structure intact for Finder / Applications.
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip_path"
  echo "App Mac publicada: $zip_path (desde $base)"
  published=$((published + 1))
done

# Publish the DMG installer next to the portable .app zip.
dmgs=(
  "$project_root"/src-tauri/target/*/release/bundle/dmg/*.dmg
  "$project_root"/src-tauri/target/release/bundle/dmg/*.dmg
)
published_dmgs=0
for dmg in "${dmgs[@]}"; do
  [[ -f "$dmg" ]] || continue

  lower="$(printf '%s' "$dmg" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower" == *aarch64* || "$lower" == *arm64* ]]; then
    stable="ComesADE-arm64.dmg"
  elif [[ "$lower" == *x86_64* || "$lower" == *x64* ]]; then
    stable="ComesADE-x64.dmg"
  else
    case "$(uname -m)" in
      arm64|aarch64) stable="ComesADE-arm64.dmg" ;;
      x86_64|amd64) stable="ComesADE-x64.dmg" ;;
      *)
        echo "No se pudo detectar la arquitectura de macOS: $(uname -m)" >&2
        exit 1
        ;;
    esac
  fi

  cp -f "$dmg" "$release_dir/$stable"
  echo "Instalador DMG publicado: $release_dir/$stable"
  published_dmgs=$((published_dmgs + 1))
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

if (( published_dmgs == 0 )); then
  echo "No se pudo publicar ningun .dmg de Mac." >&2
  exit 1
fi

echo "Listo. Artefactos en releases/: .app.zip + .dmg por arquitectura y artefactos del updater."
