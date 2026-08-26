#!/usr/bin/env bash
# Local-only Mac package (no Apple certificate, no GitHub). Run on a Mac:
#   npm run package:macos
# Output:
#   releases/ComesADE-arm64.app.zip + ComesADE-arm64.dmg
#   (or the corresponding x64 files)
# Inside the zip: ComesADE.app

set -euo pipefail
cd "$(dirname "$0")/.."
npm run build:macos:local
npm run publish:macos
