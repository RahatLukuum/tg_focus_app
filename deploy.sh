#!/usr/bin/env bash
set -euo pipefail

# === Конфигурация ===
VPS_USER="root"
VPS_HOST="83.222.21.227"
VPS_PROJECT="/opt/tg_focus_app"
VPS_WEBROOT="/var/www/tg-focus"
BRANCH="denis-branch"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

echo ""
echo "==============================="
echo "  Деплой на VPS ($VPS_HOST)"
echo "==============================="
echo ""

cd "$(dirname "$0")"

# === 1. Локальный коммит и пуш ===
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
info "Подключаюсь к VPS..."

ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=30 "${VPS_USER}@${VPS_HOST}" bash -s -- "$VPS_PROJECT" "$VPS_WEBROOT" "$BRANCH" << 'REMOTE_SCRIPT'
set -euo pipefail

PROJECT="$1"
WEBROOT="$2"
BRANCH="$3"

info()  { echo -e "\033[0;32m[✓]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[!]\033[0m $*"; }
error() { echo -e "\033[0;31m[✗]\033[0m $*"; exit 1; }

cd "$PROJECT" || error "Папка $PROJECT не найдена"

# --- Обновить код ---
info "Обновляю код..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# --- Бэкенд ---
info "Пересобираю бэкенд (Docker, без кеша)..."
cd "$PROJECT/backend"
docker compose build --no-cache 2>&1 | tail -8
docker compose up -d 2>&1 | tail -5

info "Жду запуска бэкенда..."
OK=0
for i in 1 2 3 4 5 6; do
    sleep 3
    if curl -sf http://127.0.0.1:8080/healthz 2>/dev/null | grep -q '"ok"'; then
        OK=1
        break
    fi
    warn "Попытка $i/6 — ещё не готов..."
done

if [[ "$OK" -eq 1 ]]; then
    info "Бэкенд OK"
else
    warn "Бэкенд не ответил за 18 секунд. Логи:"
    docker compose logs --tail 30
    error "Бэкенд не запустился"
fi

# --- Фронтенд ---
info "Собираю фронтенд..."
cd "$PROJECT/frontend"
npm ci --silent 2>&1 | tail -3
rm -rf dist
npm run build 2>&1 | tail -5

# Проверка путей
if grep -q '/app/assets' dist/index.html 2>/dev/null; then
    warn "index.html содержит:"
    grep -E "src=|href=" dist/index.html
    error "Сборка содержит /app/assets — проверь VITE_BASE в .env.production"
fi

info "Пути в index.html:"
grep -E "src=|href=" dist/index.html

# --- Деплой в nginx ---
info "Копирую в $WEBROOT..."
mkdir -p "$WEBROOT"
rm -rf "${WEBROOT:?}"/*
cp -r dist/* "$WEBROOT/"
chown -R www-data:www-data "$WEBROOT"

if [[ -f "$PROJECT/ops/nginx/tg-focus.conf" ]]; then
    info "Обновляю nginx конфиг..."
    cp "$PROJECT/ops/nginx/tg-focus.conf" /etc/nginx/sites-enabled/tg-focus
fi

nginx -t 2>&1 && systemctl reload nginx
info "Nginx перезагружен"

echo ""
info "=== Деплой завершён ==="
REMOTE_SCRIPT

echo ""
info "Готово! Сайт: http://${VPS_HOST}"
