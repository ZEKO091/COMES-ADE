#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script debe ejecutarse en macOS." >&2
  exit 2
fi

target_args=()
if [[ -n "${TAURI_TARGET:-}" ]]; then
  target_args+=(--target "$TAURI_TARGET")
fi

npm run tauri build -- --config src-tauri/tauri.updater.conf.json --bundles dmg "${target_args[@]}"
