#!/bin/zsh
set -euo pipefail

APP_NAME="Telegram Assistant.app"
APPS_DIR="/Applications"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

HOST_ARCH="$(uname -m)" # arm64 | x86_64

find_built_app() {
  # Ищем собранный .app напрямую (предпочтительно)
  local candidate
  candidate=$(find "$SCRIPT_DIR/src-tauri/target/release/bundle/macos" -maxdepth 1 -type d -name "$APP_NAME" 2>/dev/null | head -n 1 || true)
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  echo ""
}

find_dmg() {
  # Ищем .dmg рядом со скриптом и в стандартной папке tauri bundle
  local candidate
  # 1) Сначала пробуем универсальный билд, если есть
  candidate=$(find "$SCRIPT_DIR" -maxdepth 1 -type f -name "Telegram Assistant_*universal*.dmg" 2>/dev/null | head -n 1 || true)
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  # 2) Затем пробуем подходящий под архитектуру
  if [ "$HOST_ARCH" = "arm64" ]; then
    candidate=$(find "$SCRIPT_DIR" -maxdepth 1 -type f \( -name "Telegram Assistant_*arm64*.dmg" -o -name "Telegram Assistant_*aarch64*.dmg" \) 2>/dev/null | head -n 1 || true)
  else
    candidate=$(find "$SCRIPT_DIR" -maxdepth 1 -type f \( -name "Telegram Assistant_*x64*.dmg" -o -name "Telegram Assistant_*x86_64*.dmg" \) 2>/dev/null | head -n 1 || true)
  fi
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  # 3) Ищем во внутренних bundle-папках по тем же правилам
  candidate=$(find "$SCRIPT_DIR/src-tauri/target/release/bundle" -type f -name "Telegram Assistant_*universal*.dmg" 2>/dev/null | head -n 1 || true)
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  if [ "$HOST_ARCH" = "arm64" ]; then
    candidate=$(find "$SCRIPT_DIR/src-tauri/target/release/bundle" -type f \( -name "Telegram Assistant_*arm64*.dmg" -o -name "Telegram Assistant_*aarch64*.dmg" \) 2>/dev/null | head -n 1 || true)
  else
    candidate=$(find "$SCRIPT_DIR/src-tauri/target/release/bundle" -type f \( -name "Telegram Assistant_*x64*.dmg" -o -name "Telegram Assistant_*x86_64*.dmg" \) 2>/dev/null | head -n 1 || true)
  fi
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  # 4) Фолбэк — любой .dmg
  candidate=$(find "$SCRIPT_DIR" -maxdepth 1 -type f -name "Telegram Assistant_*.dmg" 2>/dev/null | head -n 1 || true)
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  candidate=$(find "$SCRIPT_DIR/src-tauri/target/release/bundle" -type f -name "Telegram Assistant_*.dmg" 2>/dev/null | head -n 1 || true)
  if [ -n "$candidate" ]; then echo "$candidate"; return; fi
  echo ""
}

BUILT_APP=$(find_built_app)
DMG_PATH=$(find_dmg)

install_from_app() {
  local src_app="$1"
  echo "Устанавливаю из собранного .app: $src_app -> $APPS_DIR/$APP_NAME"
  rm -rf "$APPS_DIR/$APP_NAME" 2>/dev/null || true
  ditto "$src_app" "$APPS_DIR/$APP_NAME"
  xattr -dr com.apple.quarantine "$APPS_DIR/$APP_NAME" 2>/dev/null || true
  echo "Запускаю приложение..."
  open -a "$APPS_DIR/$APP_NAME"
  echo "Готово."
}

# 1) Если есть готовый .app в bundle/macos — используем его (самый надёжный вариант)
if [ -n "$BUILT_APP" ] && [ -d "$BUILT_APP" ]; then
  install_from_app "$BUILT_APP"
  exit 0
fi

# 2) Иначе, если есть DMG — ставим из DMG
if [ -n "$DMG_PATH" ]; then
  echo "Монтирую DMG: $DMG_PATH"
  # Берём строку с /Volumes/ и вырезаем путь тома целиком (с пробелами)
  MOUNT_LINE=$(hdiutil attach "$DMG_PATH" -nobrowse | grep '/Volumes/' | tail -n1 || true)
  MOUNT_POINT=$(printf "%s\n" "$MOUNT_LINE" | sed -E 's|.*(/Volumes/.*)$|\1|')
  if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT" ]; then
    echo "Не удалось определить точку монтирования DMG"
    exit 1
  fi

  cleanup() {
    hdiutil detach "$MOUNT_POINT" -quiet || true
  }
  trap cleanup EXIT

  APP_SRC=""
  if [ -d "$MOUNT_POINT/$APP_NAME" ]; then
    APP_SRC="$MOUNT_POINT/$APP_NAME"
  else
    # Ищем именно Telegram Assistant.app (если структура отличается)
    APP_SRC=$(find "$MOUNT_POINT" -maxdepth 2 -type d -name "$APP_NAME" | head -n 1 || true)
    # Fallback: первая .app
    if [ -z "$APP_SRC" ]; then
      APP_SRC=$(find "$MOUNT_POINT" -maxdepth 2 -type d -name "*.app" | head -n 1 || true)
    fi
  fi

  if [ -z "$APP_SRC" ] || [ ! -d "$APP_SRC" ]; then
    echo "Внутри DMG не найдено приложение .app"
    exit 1
  fi

  echo "Устанавливаю в /Applications (перезапись, если было)..."
  rm -rf "$APPS_DIR/$APP_NAME" 2>/dev/null || true
  ditto "$APP_SRC" "$APPS_DIR/$APP_NAME"
  xattr -dr com.apple.quarantine "$APPS_DIR/$APP_NAME" 2>/dev/null || true

  echo "Запускаю приложение..."
  open -a "$APPS_DIR/$APP_NAME"
  echo "Готово. В следующий раз просто запускайте этот файл — он откроет приложение."
  exit 0
fi

# .dmg не найден — если установлено, просто открываем; иначе пробуем собрать
if [ -d "$APPS_DIR/$APP_NAME" ]; then
  open -a "$APPS_DIR/$APP_NAME"
  exit 0
fi

echo ".dmg не найдено и приложение не установлено. Собираю установщик (это может занять несколько минут)..."
if ! command -v npm >/dev/null 2>&1; then
  echo "npm не найден. Установите Node.js (https://nodejs.org) и повторите."
  exit 1
fi
(
  cd "$SCRIPT_DIR"
  npm run tauri:build
)
BUILT_APP=$(find_built_app)
DMG_PATH=$(find_dmg)

# После сборки снова предпочитаем установку из готового .app
if [ -n "$BUILT_APP" ] && [ -d "$BUILT_APP" ]; then
  install_from_app "$BUILT_APP"
  exit 0
fi

if [ -z "$DMG_PATH" ]; then
  echo "Не удалось найти .dmg после сборки. Проверьте вывод сборки."
  exit 1
fi

echo "Монтирую DMG: $DMG_PATH"
MOUNT_LINE=$(hdiutil attach "$DMG_PATH" -nobrowse | grep '/Volumes/' | tail -n1 || true)
MOUNT_POINT=$(printf "%s\n" "$MOUNT_LINE" | sed -E 's|.*(/Volumes/.*)$|\1|')
if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT" ]; then
  echo "Не удалось определить точку монтирования DMG"
  exit 1
fi
cleanup() { hdiutil detach "$MOUNT_POINT" -quiet || true; }
trap cleanup EXIT

APP_SRC=$(find "$MOUNT_POINT" -maxdepth 2 -type d -name "*.app" | head -n 1 || true)
if [ -z "$APP_SRC" ] || [ ! -d "$APP_SRC" ]; then
  echo "Внутри DMG не найдено приложение .app"
  exit 1
fi

echo "Устанавливаю в /Applications..."
rm -rf "$APPS_DIR/$APP_NAME" 2>/dev/null || true
ditto "$APP_SRC" "$APPS_DIR/$APP_NAME"
xattr -dr com.apple.quarantine "$APPS_DIR/$APP_NAME" 2>/dev/null || true
open -a "$APPS_DIR/$APP_NAME"
echo "Готово."

