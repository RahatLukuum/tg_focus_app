#!/bin/zsh
set -euo pipefail

APP_DEV_NAME="Telegram Assistant Dev.app"
TARGET_APP="/Applications/${APP_DEV_NAME}"
FRONTEND_DIR="/Users/macbook/Desktop/tg_my/frontend"

echo "Создаю ярлык-приложение в Applications, запускающее dev (tauri:dev)..."

TMP_AS='/tmp/tg_assistant_dev.applescript'
cat > "$TMP_AS" <<OSA
do shell script "/bin/zsh -lc 'cd ${FRONTEND_DIR} && VITE_TAURI=1 npm run tauri:dev'"
OSA

rm -rf "${TARGET_APP}" 2>/dev/null || true
osacompile -o "${TARGET_APP}" "$TMP_AS"

echo "Установлено: ${TARGET_APP}"
echo "Теперь можно открывать приложение кликом из Программ: ${APP_DEV_NAME}"

