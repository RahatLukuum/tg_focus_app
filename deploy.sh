#!/usr/bin/env bash
set -euo pipefail

# === Конфигурация ===
VPS_USER="root"
VPS_HOST="94.131.109.193"
VPS_PROJECT="/opt/tg_focus_app"
VPS_WEBROOT="/var/www/tg-focus"
BRANCH="denis-branch"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# === 1. Локальный коммит и пуш ===
echo ""
echo "==============================="
echo "  Деплой на VPS ($VPS_HOST)"
echo "==============================="
echo ""

cd "$(dirname "$0")"

if [[ -n "$(git status --porcelain)" ]]; then
    info "Есть незакоммиченные изменения — коммичу..."
    git add -A
    git commit -m "deploy: $(date '+%Y-%m-%d %H:%M')"
else
    info "Рабочая директория чистая"
fi

info "Пушу в $BRANCH..."
git push origin "$BRANCH" || error "Не удалось запушить"

# === 2. Деплой на VPS по SSH ===
info "Подключаюсь к VPS и деплою..."

ssh "${VPS_USER}@${VPS_HOST}" bash -s -- "$VPS_PROJECT" "$VPS_WEBROOT" "$BRANCH" << 'REMOTE_SCRIPT'
set -euo pipefail

PROJECT="$1"
WEBROOT="$2"
BRANCH="$3"

info()  { echo -e "\033[0;32m[✓]\033[0m $*"; }
error() { echo -e "\033[0;31m[✗]\033[0m $*"; exit 1; }

cd "$PROJECT" || error "Папка $PROJECT не найдена"

# Сбросить локальные конфликты и подтянуть код
info "Обновляю код..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Бэкенд
info "Пересобираю бэкенд (Docker)..."
cd "$PROJECT/backend"
docker compose up --build -d 2>&1 | tail -5
sleep 2

HEALTH=$(curl -sf http://127.0.0.1:8080/healthz 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok"'; then
    info "Бэкенд OK: $HEALTH"
else
    error "Бэкенд не отвечает! Логи: docker compose logs --tail 30"
fi

# Фронтенд
info "Собираю фронтенд..."
cd "$PROJECT/frontend"
npm ci --silent 2>&1 | tail -3
rm -rf dist
npm run build 2>&1 | tail -5

if grep -q '/app/assets' dist/index.html 2>/dev/null; then
    error "Сборка содержит /app/assets — base не исправлен!"
fi
info "Пути в index.html:"
grep -E "src=|href=" dist/index.html

# Деплой в nginx
info "Копирую в $WEBROOT..."
mkdir -p "$WEBROOT"
rm -rf "${WEBROOT:?}"/*
cp -r dist/* "$WEBROOT/"
chown -R www-data:www-data "$WEBROOT"

nginx -t 2>&1 && systemctl reload nginx
info "Nginx перезагружен"

echo ""
info "=== Деплой завершён ==="
REMOTE_SCRIPT

echo ""
info "Готово! Сайт: http://${VPS_HOST}"
