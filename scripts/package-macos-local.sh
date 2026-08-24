#!/usr/bin/env bash
# Local-only Mac package (no GitHub). Run on a Mac:
#   npm run package:macos
# Output:
#   releases/ComesADE-arm64.app.zip  (or ComesADE-x64.app.zip)
# Inside the zip: ComesADE.app

set -euo pipefail
cd "$(dirname "$0")/.."
npm run release:macos
