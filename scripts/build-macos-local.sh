#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Este script debe ejecutarse en macOS; GitHub Actions usa un runner macOS para este flujo." >&2
  exit 2
fi

target_args=()
if [[ -n "${TAURI_TARGET:-}" ]]; then
  target_args+=(--target "$TAURI_TARGET")
fi

# Local/test build: no Apple Developer certificate and no updater key.
# tauri.local.conf.json uses an ad-hoc identity so macOS does not report the
# downloaded app as damaged. It is not notarized for public distribution.
npm run tauri build -- \
  --config src-tauri/tauri.local.conf.json \
  --bundles app,dmg \
  "${target_args[@]}"
