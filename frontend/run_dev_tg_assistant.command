#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Запускаю dev-версию (как npm run tauri:dev)..."
VITE_TAURI=1 npm run tauri:dev

