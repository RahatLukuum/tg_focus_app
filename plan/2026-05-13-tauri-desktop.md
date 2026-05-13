# Tauri Desktop App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить веб-приложение `tg_focus_app` в кросс-платформенный Tauri-десктоп для macOS и Windows, который ходит на тот же VPS-бэкенд по HTTPS, показывает Telegram-стиль уведомления о новых сообщениях и иконку в системном трее.

**Architecture:** Tauri v2 shell внутри `frontend/src-tauri/` оборачивает существующий Vite+React фронт. Десктоп билд использует отдельный `.env.tauri` с HTTPS API URL (`https://185-252-215-73.nip.io`). На VPS поднимаем nginx с Let's Encrypt сертификатом для nip.io домена и проксируем как раньше на FastAPI :8080. Уведомления через `tauri-plugin-notification`, трей через нативный `TrayIconBuilder` (только desktop, не mobile).

**Tech Stack:**
- Tauri v2 + Rust (existing)
- Plugins: `tauri-plugin-notification ^2`, `tauri-plugin-single-instance ^2`, `tauri-plugin-autostart ^2` (опционально)
- Frontend: `@tauri-apps/api ^2`, `@tauri-apps/plugin-notification ^2`
- VPS: nginx + certbot, домен `185-252-215-73.nip.io`

---

## Phase 0: VPS — TLS via nip.io + Let's Encrypt

**Goal:** Бэкенд доступен по `https://185-252-215-73.nip.io` и `wss://185-252-215-73.nip.io/ws`. Web frontend продолжает работать как раньше через тот же домен.

**Pre-requisites:** SSH-доступ к VPS (`ssh root@185.252.215.73`). Текущий nginx-конфиг — `/etc/nginx/sites-enabled/tg-focus` (синхронизируется из `ops/nginx/tg-focus.conf` при `./deploy.sh`).

### Task 0.1: Проверить DNS-резолв и подготовить новый nginx-конфиг

**Files:**
- Create: `ops/nginx/tg-focus.conf` (overwrite — добавить HTTPS server-block и редирект)

- [ ] **Step 1: Подключиться к VPS и проверить, что nip.io резолвится**

Run на локальной машине:
```bash
ssh root@185.252.215.73 "dig +short 185-252-215-73.nip.io"
```
Expected output:
```
185.252.215.73
```
Если выводит другой IP — что-то с DNS, разобраться отдельно перед продолжением.

- [ ] **Step 2: Установить certbot и плагин для nginx (если не стоят)**

Run на VPS:
```bash
ssh root@185.252.215.73 "apt update && apt install -y certbot python3-certbot-nginx"
```
Expected: `certbot --version` → `certbot 2.x.x` или выше.

- [ ] **Step 3: Переписать локальный `ops/nginx/tg-focus.conf` с HTTPS + редиректом**

```nginx
# /etc/nginx/sites-enabled/tg-focus
# HTTP → HTTPS редирект
server {
    listen 80;
    server_name 185-252-215-73.nip.io 185.252.215.73;

    # Let's Encrypt webroot challenge — оставляем доступным по HTTP
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://185-252-215-73.nip.io$request_uri;
    }
}

# HTTPS основной сервер
server {
    listen 443 ssl http2;
    server_name 185-252-215-73.nip.io;
    root /var/www/tg-focus;
    index index.html;

    # SSL — заполнится certbot'ом
    ssl_certificate /etc/letsencrypt/live/185-252-215-73.nip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/185-252-215-73.nip.io/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # SPA: serve index.html для всех путей, которые не маппятся на файл/API.
    set $is_html 0;
    if ($http_accept ~* "text/html") {
        set $is_html 1;
    }
    if ($http_x_requested_with = "XMLHttpRequest") {
        set $is_html 0;
    }

    # API endpoints — exact prefixes proxied to FastAPI on :8080.
    location ~ ^/(auth|me|dialogs|tasks|folders|messages|send_message|queue|ws|healthz|media|contacts|bootstrap|send_media|resolve_contact|generate_reply|chat_info|topics|archived_dialogs) {
        if ($is_html = 1) {
            rewrite ^ /index.html last;
        }
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;

        # WebSocket таймауты — TG может молчать длинными кусками
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Default: try real file, then fall back to SPA index.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 4: Скоммитить конфиг (но не деплоить ещё)**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app
git add ops/nginx/tg-focus.conf
git commit -m "ops(nginx): https server-block for 185-252-215-73.nip.io"
```

### Task 0.2: Выпустить сертификат Let's Encrypt

**Files:** изменения только на VPS.

- [ ] **Step 1: Залить _промежуточный_ HTTP-only конфиг для прохождения ACME-challenge**

Создать на VPS файл `/etc/nginx/sites-enabled/tg-focus-pre-ssl`:
```bash
ssh root@185.252.215.73 bash -s << 'EOF'
mkdir -p /var/www/certbot
cat > /etc/nginx/sites-enabled/tg-focus-pre-ssl << 'NGINX'
server {
    listen 80;
    server_name 185-252-215-73.nip.io;
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 200 'cert-pending';
        add_header Content-Type text/plain;
    }
}
NGINX
# временно отключим основной tg-focus конфиг (он слушает на 80 без server_name = совпадет)
mv /etc/nginx/sites-enabled/tg-focus /etc/nginx/sites-enabled/tg-focus.disabled || true
nginx -t && systemctl reload nginx
EOF
```
Expected output: `nginx: configuration file /etc/nginx/nginx.conf test is successful`.

- [ ] **Step 2: Запустить certbot в webroot-режиме**

```bash
ssh root@185.252.215.73 "certbot certonly --webroot -w /var/www/certbot -d 185-252-215-73.nip.io --email dengud79@gmail.com --agree-tos --non-interactive"
```
Expected output (последние строки):
```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/185-252-215-73.nip.io/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/185-252-215-73.nip.io/privkey.pem
```
Если ошибка `DNS problem: NXDOMAIN` — значит DNS не резолвится (см. Task 0.1 Step 1). Если ошибка `too many redirects` — проверь, что pre-ssl конфиг активен и не редиректит.

- [ ] **Step 3: Убедиться, что присутствуют options-ssl-nginx.conf и ssl-dhparams.pem**

```bash
ssh root@185.252.215.73 "ls /etc/letsencrypt/options-ssl-nginx.conf /etc/letsencrypt/ssl-dhparams.pem"
```
Expected: оба файла существуют (certbot их создаёт).
Если нет: `apt install -y certbot-nginx` либо скачать из репозитория certbot.

- [ ] **Step 4: Включить итоговый HTTPS-конфиг, отключить pre-ssl**

```bash
ssh root@185.252.215.73 bash -s << 'EOF'
rm -f /etc/nginx/sites-enabled/tg-focus-pre-ssl
# вернём основной конфиг (тот, который пуш-нём из репо в Task 0.3)
mv /etc/nginx/sites-enabled/tg-focus.disabled /etc/nginx/sites-enabled/tg-focus 2>/dev/null || true
EOF
```

### Task 0.3: Деплой нового nginx-конфига и smoke-test

- [ ] **Step 1: Запушить ветку `denis-branch` (deploy.sh сам зальёт)**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app
./deploy.sh
```
deploy.sh заменит `/etc/nginx/sites-enabled/tg-focus` нашим новым конфигом и сделает `nginx -t && systemctl reload nginx`.
Expected: в логах deploy.sh → `[✓] Nginx перезагружен`.

- [ ] **Step 2: Smoke-test HTTPS API**

```bash
curl -sS https://185-252-215-73.nip.io/healthz
```
Expected output:
```json
{"status":"ok"}
```
(или что возвращает `/healthz` сейчас — посмотри `backend/main.py`).

- [ ] **Step 3: Smoke-test WSS**

```bash
curl -sSI -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" https://185-252-215-73.nip.io/ws
```
Expected: HTTP/1.1 426 или 101 — главное, не 404 и не 502. Если 426 — fine, WS работает, просто curl не полноценный клиент.

- [ ] **Step 4: Smoke-test веб-фронт по новому домену**

Открыть в браузере: https://185-252-215-73.nip.io
Expected: SPA загружается, замок зелёный (TLS валидный).
Если frontend всё ещё ходит на http://185.252.215.73 (т.е. на старый IP) — это потому что мы ещё не пересобрали `.env.production`. Не критично для Phase 0 — поправим в Phase 2.

- [ ] **Step 5: Включить auto-renew certbot и проверить cron**

```bash
ssh root@185.252.215.73 "systemctl list-timers | grep certbot"
```
Expected: видно `certbot.timer` со следующим запуском в течение 12 часов. Certbot ставится с systemd-timer'ом сам.

Manual dry-run:
```bash
ssh root@185.252.215.73 "certbot renew --dry-run"
```
Expected: `Congratulations, all simulated renewals succeeded`.

- [ ] **Step 6: Commit + Push**

```bash
git status   # должна быть чистая после deploy.sh
git log --oneline -3
```
Expected: коммит `ops(nginx): https server-block for 185-252-215-73.nip.io` уже запушен.

---

## Phase 1: Починка существующего `frontend/src-tauri/`

**Goal:** Существующий Tauri v2 shell приведён к каноничной структуре: `lib.rs` отдельно, `capabilities/default.json` создан, `tauri.conf.json` исправлен (опечатка IP убрана, идентификатор приведён к reverse-DNS, иконки и Windows-bundle сконфигурированы).

### Task 1.1: Split `main.rs` → `lib.rs` (mobile-readiness, future-proof)

**Files:**
- Modify: `frontend/src-tauri/src/main.rs`
- Create: `frontend/src-tauri/src/lib.rs`
- Modify: `frontend/src-tauri/Cargo.toml` (добавить `[lib]` секцию)

- [ ] **Step 1: Создать `lib.rs` с переездом всей логики**

```rust
// frontend/src-tauri/src/lib.rs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: Уменьшить `main.rs` до passthrough**

```rust
// frontend/src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tg_assistant_lib::run();
}
```

- [ ] **Step 3: Добавить `[lib]` секцию в `Cargo.toml`**

В файле `frontend/src-tauri/Cargo.toml` после блока `[package]` вставить:
```toml
[lib]
name = "tg_assistant_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

- [ ] **Step 4: Verify build (debug)**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -20
```
Expected: `Finished dev [unoptimized + debuginfo] target(s)` или `Finished release [optimized] target(s)`. Если ошибка `cannot find function 'run' in crate` — проверь имя в `[lib].name`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/src/main.rs frontend/src-tauri/src/lib.rs frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock
git commit -m "refactor(tauri): split main.rs into lib.rs for mobile-readiness"
```

### Task 1.2: Создать `capabilities/default.json`

**Files:**
- Create: `frontend/src-tauri/capabilities/default.json`
- Modify: `frontend/src-tauri/tauri.conf.json` (добавить `app.security.capabilities`)

- [ ] **Step 1: Создать capabilities-файл**

```json
{
    "$schema": "../gen/schemas/desktop-schema.json",
    "identifier": "default",
    "description": "Default desktop capabilities for tg_assistant",
    "windows": ["main"],
    "permissions": [
        "core:default",
        "core:window:allow-show",
        "core:window:allow-hide",
        "core:window:allow-set-focus",
        "core:window:allow-unminimize",
        "core:window:allow-close",
        "shell:default"
    ]
}
```

Notification и tray permissions добавим в Phase 3 и 4 соответственно.

- [ ] **Step 2: Прописать в `tauri.conf.json` ссылку на capabilities**

В файле `frontend/src-tauri/tauri.conf.json`, в блоке `app`, после `windows[]`, добавить `security`:
```json
"app": {
    "windows": [...],
    "security": {
        "capabilities": ["default"]
    }
}
```

- [ ] **Step 3: Дать окну `label: "main"`**

Capabilities ссылаются на окно по label. Сейчас в `tauri.conf.json` окно без label. Изменить:
```json
"windows": [
    {
        "label": "main",
        "title": "Telegram Assistant",
        "width": 1200,
        "height": 800,
        "resizable": true
    }
]
```

- [ ] **Step 4: Verify**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -5
```
Expected: build проходит. Если "capability 'default' not found" — проверь, что файл лежит в `frontend/src-tauri/capabilities/` (а не где-то ещё).

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/capabilities/default.json frontend/src-tauri/tauri.conf.json
git commit -m "feat(tauri): add default capabilities + label=main window"
```

### Task 1.3: Исправить `tauri.conf.json` — опечатка IP, идентификатор, иконки, Win-bundle

**Files:**
- Modify: `frontend/src-tauri/tauri.conf.json`

- [ ] **Step 1: Полностью переписать tauri.conf.json**

Текущая опечатка `185.250.149.23` уйдёт целиком — после Phase 0 у нас HTTPS, `exceptionDomain` больше не нужен. Identifier приведём к reverse-DNS виду (Tauri рекомендует).

```json
{
    "$schema": "https://schema.tauri.app/config/2",
    "productName": "Telegram Assistant",
    "version": "0.1.0",
    "identifier": "com.tgassistant.desktop",
    "build": {
        "beforeBuildCommand": "VITE_TAURI=1 npm run build -- --mode tauri",
        "beforeDevCommand": "VITE_TAURI=1 npm run dev -- --mode tauri",
        "devUrl": "http://localhost:5173",
        "frontendDist": "../dist"
    },
    "app": {
        "windows": [
            {
                "label": "main",
                "title": "Telegram Assistant",
                "width": 1200,
                "height": 800,
                "minWidth": 800,
                "minHeight": 600,
                "resizable": true
            }
        ],
        "security": {
            "capabilities": ["default"],
            "csp": null
        }
    },
    "bundle": {
        "active": true,
        "targets": ["dmg", "msi", "nsis"],
        "icon": [
            "icons/32x32.png",
            "icons/128x128.png",
            "icons/128x128@2x.png",
            "icons/icon.icns",
            "icons/icon.ico"
        ],
        "macOS": {
            "minimumSystemVersion": "10.15"
        },
        "windows": {
            "wix": {
                "language": ["en-US"]
            }
        }
    }
}
```

Изменения:
- `identifier`: `tg.assistant` → `com.tgassistant.desktop` (reverse-DNS, не конфликтует с реальными доменами)
- `bundle.targets`: было `"all"` (тянет .deb/.rpm) → теперь только `["dmg", "msi", "nsis"]` под наши платформы
- `bundle.icon`: добавлены PNG-варианты и `.ico` (для Windows)
- `macOS.exceptionDomain` УБРАН — после Phase 0 HTTPS не нужен
- Окно: `label: "main"`, `minWidth/minHeight` для UX
- `beforeBuildCommand`: добавлен `-- --mode tauri` (понадобится в Phase 2)

- [ ] **Step 2: Verify** (build без bundle, чтобы убедиться что конфиг парсится)

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -10
```
Expected: завершается без ошибок типа `failed to parse tauri.conf.json`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src-tauri/tauri.conf.json
git commit -m "fix(tauri): correct identifier/icons/bundle targets, remove stale exceptionDomain"
```

---

## Phase 2: Tauri-aware build mode + исправление IP-багов

**Goal:** Tauri build использует `.env.tauri` с HTTPS API URL. Веб-билд продолжает использовать `.env.production` (без изменений в продакшен URL). Опечатка fallback IP в `telegramApi.ts` исправлена.

### Task 2.1: Создать `.env.tauri`

**Files:**
- Create: `frontend/.env.tauri`

- [ ] **Step 1: Создать файл**

```
# frontend/.env.tauri
# Используется при `vite build --mode tauri` (в Tauri-сборке)
VITE_API_BASE_URL=https://185-252-215-73.nip.io
VITE_BASE=/
VITE_ROUTER_BASE=/
VITE_TAURI=1
```

Заметь: `VITE_BASE=/` (Tauri сам подставит `./` через `vite.config.ts::resolveBase` потому что мы выставим `VITE_TAURI=1`, и условие `if (env.VITE_TAURI || ...) return "./"` сработает раньше).

- [ ] **Step 2: Добавить .env.tauri в `.gitignore` НЕ нужно** — не содержит секретов, должен быть в репо.

Проверь:
```bash
grep -E "^\.env" /Users/den1shh/Documents/growfood/tg_focus_app/.gitignore /Users/den1shh/Documents/growfood/tg_focus_app/frontend/.gitignore 2>/dev/null
```
Если `.env*` игнорируется глобально — добавить исключение `!frontend/.env.tauri` либо переименовать в `frontend/.env.tauri.example` + копировать при сборке. Скорее всего исключения не нужны, но проверь.

- [ ] **Step 3: Commit**

```bash
git add frontend/.env.tauri
git commit -m "feat(tauri): add .env.tauri with HTTPS API URL for desktop builds"
```

### Task 2.2: Исправить hardcoded fallback IP в `telegramApi.ts`

**Files:**
- Modify: `frontend/src/services/telegramApi.ts:18`

- [ ] **Step 1: Прочитать текущее значение строки 18 и заменить**

Текущая строка:
```ts
this.baseUrl = (envBase && envBase.trim()) || 'http://185.250.149.23:8080';
```

Заменить на:
```ts
this.baseUrl = (envBase && envBase.trim()) || 'https://185-252-215-73.nip.io';
```

Причины:
- Опечатка `185.250.149.23` → правильный `185.252.215.73` (через nip.io)
- HTTP → HTTPS (после Phase 0)
- `:8080` убрать (nginx проксирует на 80/443)

- [ ] **Step 2: Verify TS-компиляция**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npx tsc --noEmit
```
Expected: 0 ошибок. Если есть — это **существующие** ошибки, не наши.

- [ ] **Step 3: Verify lint**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run lint
```
Expected: 0 new warnings.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/telegramApi.ts
git commit -m "fix(telegram-api): correct fallback URL typo + use HTTPS via nip.io"
```

### Task 2.3: Поправить fallback в `tasksApi.ts` и `foldersApi.ts` (если такая же бага)

**Files:**
- Modify (если нужно): `frontend/src/services/tasksApi.ts`, `frontend/src/services/foldersApi.ts`

- [ ] **Step 1: Найти все хардкод-IP**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app
grep -rn "185.250.149.23\|185.252.215.73\|94.131.109.193" frontend/src --include="*.ts" --include="*.tsx"
```
Expected: видим все вхождения. Каждое в `services/*` нужно заменить на новый HTTPS-URL или относительный путь.

- [ ] **Step 2: Заменить каждое найденное hardcoded на `https://185-252-215-73.nip.io`** (используя Edit)

Для каждого совпадения — Edit-операция, аналогично Task 2.2.

- [ ] **Step 3: Verify**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app
grep -rn "185.250" frontend/src
```
Expected: пусто (никаких опечаток не осталось).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/
git commit -m "fix(api-clients): replace hardcoded IPs with HTTPS via nip.io"
```

---

## Phase 3: OS-уведомления (Telegram-style)

**Goal:** В Tauri-десктопе при получении нового сообщения по WebSocket появляется системное уведомление: title = имя диалога, body = текст. Клик по уведомлению фокусит окно и навигирует на `/chat/<id>` (или `/message/<id>`).

### Task 3.1: Добавить `tauri-plugin-notification`

**Files:**
- Modify: `frontend/src-tauri/Cargo.toml`
- Modify: `frontend/src-tauri/src/lib.rs`
- Modify: `frontend/src-tauri/capabilities/default.json`
- Modify: `frontend/package.json`

- [ ] **Step 1: Добавить Rust зависимость**

В `frontend/src-tauri/Cargo.toml`, в секцию `[dependencies]`:
```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Зарегистрировать плагин в `lib.rs`**

```rust
// frontend/src-tauri/src/lib.rs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Добавить permission в capabilities**

В `frontend/src-tauri/capabilities/default.json`, в массив `permissions`:
```json
"notification:default"
```

Итоговый массив:
```json
"permissions": [
    "core:default",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-set-focus",
    "core:window:allow-unminimize",
    "core:window:allow-close",
    "shell:default",
    "notification:default"
]
```

- [ ] **Step 4: Добавить JS-обёртку**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm install @tauri-apps/api@^2 @tauri-apps/plugin-notification@^2
```
Expected: `added 2 packages` (или больше), оба в `dependencies`, не devDependencies (нужны runtime).

- [ ] **Step 5: Verify Rust build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -10
```
Expected: build success.

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock frontend/src-tauri/src/lib.rs frontend/src-tauri/capabilities/default.json frontend/package.json frontend/package-lock.json
git commit -m "feat(tauri): add notification plugin + permissions"
```

### Task 3.2: Создать утилиту `isTauri()` для runtime-детекции

**Files:**
- Create: `frontend/src/lib/runtime.ts`

- [ ] **Step 1: Создать модуль**

```ts
// frontend/src/lib/runtime.ts
/**
 * Returns true if running inside Tauri shell.
 * Tauri injects `__TAURI_INTERNALS__` into window — это самый надёжный способ.
 */
export function isTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
```

- [ ] **Step 2: Verify TS**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/runtime.ts
git commit -m "feat(runtime): add isTauri() helper"
```

### Task 3.3: Хук `useDesktopNotifications`

**Files:**
- Create: `frontend/src/hooks/useDesktopNotifications.ts`

- [ ] **Step 1: Создать хук**

```ts
// frontend/src/hooks/useDesktopNotifications.ts
import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/runtime";

type NotifyArgs = {
    title: string;
    body: string;
    chatId?: number | string;
    icon?: string;
};

let permissionGranted = false;

/**
 * Hook returning a `notify` function. On first call, requests OS permission.
 * No-op on web. On Tauri desktop: shows native notification.
 * Click on notification emits a Tauri event "notification-click" with chatId payload.
 */
export function useDesktopNotifications() {
    const ready = useRef(false);

    useEffect(() => {
        if (!isTauri()) return;
        let cancelled = false;
        (async () => {
            const { isPermissionGranted, requestPermission } = await import(
                "@tauri-apps/plugin-notification"
            );
            let granted = await isPermissionGranted();
            if (!granted) {
                const res = await requestPermission();
                granted = res === "granted";
            }
            if (!cancelled) {
                permissionGranted = granted;
                ready.current = granted;
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const notify = async (args: NotifyArgs) => {
        if (!isTauri() || !permissionGranted) return;
        const { sendNotification } = await import("@tauri-apps/plugin-notification");
        sendNotification({
            title: args.title,
            body: args.body,
            icon: args.icon,
        });
    };

    return { notify, ready: ready.current };
}
```

**Замечание:** `tauri-plugin-notification` v2 не передаёт payload в click-обработчик из коробки. Click-handling сделаем через emit event из Rust (Phase 5). Пока хук не пытается это решить — просто кладёт нотификации.

- [ ] **Step 2: Verify TS**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npx tsc --noEmit
```
Expected: 0 errors. Если `Cannot find module '@tauri-apps/plugin-notification'` — пересобрать deps: `rm -rf node_modules package-lock.json && npm install`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useDesktopNotifications.ts
git commit -m "feat(hooks): useDesktopNotifications — request perm + send via Tauri plugin"
```

### Task 3.4: Подключить хук к WebSocket `new_message` событию в `TelegramContext`

**Files:**
- Modify: `frontend/src/contexts/TelegramContext.tsx`

- [ ] **Step 1: Найти, где обрабатывается WS-сообщение `new_message`**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app
grep -n "new_message\|onmessage\|ws.onmessage\|connectWebSocket" frontend/src/contexts/TelegramContext.tsx | head -20
```
Expected: видим место, где WS event роутится.

- [ ] **Step 2: Импорт + использование хука**

В верхней части `TelegramContext.tsx`:
```ts
import { useDesktopNotifications } from "@/hooks/useDesktopNotifications";
```

Внутри `TelegramProvider` (до WebSocket-подключения):
```ts
const { notify } = useDesktopNotifications();
```

- [ ] **Step 3: Вызов `notify()` в обработчике `new_message`**

В обработчике WS-события `new_message` (или эквивалентном — точный код смотри в `TelegramContext.tsx`), после обновления state'a:
```ts
// псевдокод — адаптируй под реальную структуру evt
if (evt?.type === "new_message" && evt.message) {
    const chatTitle = evt.dialog?.title || evt.dialog?.name || "Telegram";
    const messageText = evt.message.text || "[медиа]";
    notify({
        title: chatTitle,
        body: messageText,
        chatId: evt.dialog?.id,
    });
}
```

**Точный shape события** — нужно посмотреть в `backend/main.py` где формируется WS-broadcast.

- [ ] **Step 4: Verify TS**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/contexts/TelegramContext.tsx
git commit -m "feat(notifications): wire desktop notifications to WS new_message events"
```

### Task 3.5: Manual smoke-test уведомлений в `tauri dev`

- [ ] **Step 1: Запустить dev-shell**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri:dev
```
Expected: открывается окно с приложением, в логе нет ошибок permission.

- [ ] **Step 2: Авторизоваться, отправить кому-то сообщение чтобы получить ответ**

При первом получении сообщения macOS/Windows должны:
- macOS: показать banner notification справа сверху
- Windows: показать toast справа снизу
- Click → пока ничего не делает (Phase 5)

Если уведомление не появилось:
- Открыть macOS System Preferences → Notifications → Telegram Assistant — проверить, что разрешено
- На Windows: Settings → Notifications & actions → Telegram Assistant — должно быть On
- В DevTools (Tauri-окно: Cmd+Option+I) — проверить console, нет ли ошибок про permission

- [ ] **Step 3: НЕ коммитим — это manual test без артефактов**

---

## Phase 4: Системный трей

**Goal:** При запуске десктопа появляется иконка в системном трее (macOS menu bar / Windows system tray). Клик ЛКМ — show/focus главное окно. Меню (ПКМ или Mac-style клик): "Show / Hide / Quit". Иконка может отображать unread badge (опционально, базово — без).

### Task 4.1: Добавить tray в `lib.rs`

**Files:**
- Modify: `frontend/src-tauri/src/lib.rs`
- Modify: `frontend/src-tauri/Cargo.toml` (`tauri` features)
- Modify: `frontend/src-tauri/capabilities/default.json`

- [ ] **Step 1: Включить `tray-icon` feature в `Cargo.toml`**

В `[dependencies]` секции изменить `tauri` так:
```toml
tauri = { version = "2", features = ["tray-icon"] }
```

- [ ] **Step 2: Расширить `lib.rs` для создания tray**

```rust
// frontend/src-tauri/src/lib.rs
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let hide_i = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

                let _tray = TrayIconBuilder::with_id("main-tray")
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("Telegram Assistant")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        use tauri::tray::TrayIconEvent;
                        if let TrayIconEvent::Click { button, button_state, .. } = event {
                            use tauri::tray::{MouseButton, MouseButtonState};
                            if button == MouseButton::Left && button_state == MouseButtonState::Up {
                                let app = tray.app_handle();
                                if let Some(w) = app.get_webview_window("main") {
                                    if w.is_visible().unwrap_or(false) {
                                        let _ = w.hide();
                                    } else {
                                        let _ = w.show();
                                        let _ = w.unminimize();
                                        let _ = w.set_focus();
                                    }
                                }
                            }
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Добавить permissions в capabilities**

В `frontend/src-tauri/capabilities/default.json`, в `permissions`:
```json
"core:tray:default"
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -15
```
Expected: компиляция Rust проходит. Возможные ошибки:
- "no method `show_menu_on_left_click`" — версия Tauri слишком старая, обнови `cargo update -p tauri`
- "trait bound not satisfied for MenuItem" — проверь `use tauri::menu::*` импорты

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock frontend/src-tauri/src/lib.rs frontend/src-tauri/capabilities/default.json
git commit -m "feat(tauri): system tray with show/hide/quit menu"
```

### Task 4.2: Manual smoke-test трея

- [ ] **Step 1: Запустить и проверить**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri:dev
```
Expected:
- В menu bar (macOS) / system tray (Windows) появилась иконка
- ЛКМ — окно показывается/скрывается toggle
- ПКМ → меню Show/Hide/Quit работает
- Quit → процесс полностью закрывается

- [ ] **Step 2: НЕ коммитим — manual test**

---

## Phase 5: Поведение окна + deep-links по клику на уведомление

**Goal:**
- Только один экземпляр приложения может быть запущен (single-instance plugin)
- Закрытие окна не выходит из приложения, а сворачивает в трей
- Клик на уведомление → window.focus() + навигация на `/chat/<id>`

### Task 5.1: Single-instance plugin

**Files:**
- Modify: `frontend/src-tauri/Cargo.toml`
- Modify: `frontend/src-tauri/src/lib.rs`

- [ ] **Step 1: Добавить зависимость**

В `Cargo.toml [dependencies]`:
```toml
tauri-plugin-single-instance = "2"
```

- [ ] **Step 2: Зарегистрировать в `lib.rs`**

В начало `pub fn run()`, до `Builder::default()`, ничего не меняем. Внутри `Builder::default()` цепочка плагинов:
```rust
.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}))
```
Поместить ПЕРВЫМ среди `.plugin(...)` — single-instance должен инициализироваться раньше всего.

- [ ] **Step 3: Verify**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -5
```
Expected: build success.

- [ ] **Step 4: Commit**

```bash
git add frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock frontend/src-tauri/src/lib.rs
git commit -m "feat(tauri): single-instance plugin (focus existing window on second launch)"
```

### Task 5.2: Close-to-tray

**Files:**
- Modify: `frontend/src-tauri/src/lib.rs`

- [ ] **Step 1: Добавить window event handler**

В `Builder::default()` цепочке, после `.setup(...)`, добавить:
```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // На клик "×" — не выходим, а прячем в трей
        let _ = window.hide();
        api.prevent_close();
    }
})
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --debug --no-bundle 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src-tauri/src/lib.rs
git commit -m "feat(tauri): close-to-tray (window close hides instead of exit)"
```

### Task 5.3: Click-on-notification → navigate

Поскольку `tauri-plugin-notification` v2 не выдаёт callback по клику на уведомление (это ограничение OS API), используем обходной путь: при клике на уведомление, **если** OS его поддерживает, она просто фокусит уже окно. У нас нет привязки "это уведомление — этот чат". Вариант — frontend сам хранит "последнее уведомление" в state, и при `window.focus()` событии навигирует.

Проще: добавить в TelegramContext "ожидаемый-к-открытию chatId" при отправке уведомления, и подписаться на Tauri `focus`-event окна. На focus — если есть pending chatId, navigate.

**Files:**
- Modify: `frontend/src/contexts/TelegramContext.tsx`
- Modify: `frontend/src/hooks/useDesktopNotifications.ts`

- [ ] **Step 1: Хранить pending chatId в хуке**

В `useDesktopNotifications.ts`:
```ts
// добавить module-level state
let pendingChatId: number | string | null = null;

export function getPendingChatId(): number | string | null {
    const cid = pendingChatId;
    pendingChatId = null;
    return cid;
}
```

И в `notify`:
```ts
if (args.chatId !== undefined) {
    pendingChatId = args.chatId;
}
```

- [ ] **Step 2: Слушать focus-event в TelegramContext**

В `TelegramContext.tsx` добавить useEffect:
```ts
useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        unlisten = await w.onFocusChanged(async ({ payload: focused }) => {
            if (focused) {
                const { getPendingChatId } = await import("@/hooks/useDesktopNotifications");
                const chatId = getPendingChatId();
                if (chatId) {
                    // navigate — нужен react-router
                    // решение через global event:
                    window.dispatchEvent(new CustomEvent("navigate-to-chat", { detail: { chatId } }));
                }
            }
        });
    })();
    return () => { unlisten?.(); };
}, []);
```

Импорт `isTauri` сверху файла.

- [ ] **Step 3: В верхнем компоненте, который имеет `navigate`, слушать**

В `App.tsx` (или там, где `BrowserRouter`):
```tsx
useEffect(() => {
    const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.chatId) {
            navigate(`/chat/${detail.chatId}`);
        }
    };
    window.addEventListener("navigate-to-chat", handler);
    return () => window.removeEventListener("navigate-to-chat", handler);
}, [navigate]);
```

Импорт `useNavigate` из `react-router-dom`. Уточни, в каком именно компоненте лучше держать (там где есть доступ к `navigate`).

- [ ] **Step 4: Добавить permission на window focus event в capabilities**

В `default.json` permissions:
```json
"core:window:allow-on-focus-changed"
```
(Если такой permission нет — гранулярные window-permissions могут быть собраны в `core:window:default`. Проверь по официальной доке Tauri.)

- [ ] **Step 5: Verify TS + build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npx tsc --noEmit && npm run tauri -- build --debug --no-bundle 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/contexts/TelegramContext.tsx frontend/src/hooks/useDesktopNotifications.ts frontend/src/App.tsx frontend/src-tauri/capabilities/default.json
git commit -m "feat(deep-link): focus-to-navigate on notification click"
```

### Task 5.4: Manual smoke-test deep-links + close-to-tray

- [ ] **Step 1:** `npm run tauri:dev`, открыть приложение, свернуть его, отправить себе сообщение, кликнуть уведомление → ожидание: окно фокусится, открывается чат-страница.

- [ ] **Step 2:** Закрыть окно через × → ожидание: окно скрывается, иконка в трее остаётся, ЛКМ по трею → возврат.

- [ ] **Step 3:** Запустить второй экземпляр через `npm run tauri:dev` (в другом терминале) → ожидание: второе окно не открывается, первое фокусится.

---

## Phase 6: Кросс-платформенная сборка

**Goal:** Получить артефакты:
- `Telegram Assistant_0.1.0_aarch64.dmg` (Mac Apple Silicon)
- `Telegram Assistant_0.1.0_x64.dmg` (Mac Intel — опционально)
- `Telegram Assistant_0.1.0_x64-setup.exe` (Windows NSIS) + `Telegram Assistant_0.1.0_x64_en-US.msi`

### Task 6.1: macOS production build

- [ ] **Step 1: Установить Rust target для Apple Silicon (если не стоит)**

```bash
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin   # опц., для Intel
```
Expected: `info: component 'rust-std' for target 'aarch64-apple-darwin' is up to date`.

- [ ] **Step 2: Production build для текущей архитектуры**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri:build
```
Expected: ~3-5 минут компиляции. Артефакт по пути:
```
frontend/src-tauri/target/release/bundle/dmg/Telegram Assistant_0.1.0_aarch64.dmg
```

- [ ] **Step 3: Verify**

Открыть `.dmg`, перетащить в Applications, запустить. Поскольку adhoc-подпись:
- Right-click → Open → "Open anyway" (macOS блокирует unsigned-апп при первом запуске)
Expected: запускается, всё работает.

- [ ] **Step 4: Universal build (опц., оба архи)**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend
npm run tauri -- build --target universal-apple-darwin
```
Это создаст fat binary x86_64 + aarch64. Артефакт: `*_universal.dmg`.

- [ ] **Step 5: Положить артефакт в `frontend/src-tauri/target/release/bundle/` — НЕ коммитим бинарники.**

Bundle артефакты добавить в `.gitignore`:
```
# frontend/src-tauri/.gitignore (добавить, если ещё нет)
target/
```

### Task 6.2: Windows production build — стратегия

Cross-compile с Mac на Windows для Tauri **не работает надёжно** из-за зависимостей wix/nsis-инструментов, которые требуют Windows. Варианты:
1. **GitHub Actions** на `windows-latest` (рекомендую — воспроизводимо)
2. **Локальная Windows VM** (Parallels/UTM/VMware) с Rust + Node + WebView2 Runtime

- [ ] **Step 1: Создать GitHub Actions workflow `.github/workflows/tauri-build.yml`**

```yaml
name: Tauri build (Windows + macOS)

on:
    push:
        tags: ["v*"]
    workflow_dispatch:

jobs:
    build-tauri:
        strategy:
            fail-fast: false
            matrix:
                os: [macos-latest, windows-latest]
        runs-on: ${{ matrix.os }}
        steps:
            - uses: actions/checkout@v4

            - name: Setup Node
              uses: actions/setup-node@v4
              with:
                  node-version: "20"

            - name: Setup Rust
              uses: dtolnay/rust-toolchain@stable

            - name: Cache Rust
              uses: swatinem/rust-cache@v2
              with:
                  workspaces: frontend/src-tauri -> target

            - name: Install frontend deps
              working-directory: frontend
              run: npm ci

            - name: Build Tauri app
              working-directory: frontend
              run: npm run tauri:build

            - name: Upload artifacts (macOS)
              if: matrix.os == 'macos-latest'
              uses: actions/upload-artifact@v4
              with:
                  name: tauri-macos
                  path: frontend/src-tauri/target/release/bundle/dmg/*.dmg

            - name: Upload artifacts (Windows)
              if: matrix.os == 'windows-latest'
              uses: actions/upload-artifact@v4
              with:
                  name: tauri-windows
                  path: |
                      frontend/src-tauri/target/release/bundle/msi/*.msi
                      frontend/src-tauri/target/release/bundle/nsis/*.exe
```

- [ ] **Step 2: Commit workflow**

```bash
mkdir -p /Users/den1shh/Documents/growfood/tg_focus_app/.github/workflows
# поместить tauri-build.yml выше
git add .github/workflows/tauri-build.yml
git commit -m "ci: tauri cross-platform build for mac + windows"
```

- [ ] **Step 3: Триггер билда (manual)**

В GitHub UI → Actions → "Tauri build (Windows + macOS)" → Run workflow.
Дождаться завершения (~10-15 мин). Скачать артефакты.

Альтернатива (если нет GitHub-репо): локальная Win VM.
**Шаги для VM**:
- Установить Rust (rustup.rs)
- Установить Node 20 (nodejs.org)
- `npm ci` в frontend/
- `npm run tauri:build`
- Артефакты в `frontend/src-tauri/target/release/bundle/msi/` и `bundle/nsis/`

---

## Phase 7: Документация + финальный smoke-test

### Task 7.1: Обновить `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Добавить секцию "Desktop (Tauri)" после "Frontend"**

```markdown
### Desktop (Tauri)
```bash
cd frontend
npm install
npm run tauri:dev          # dev окно
npm run tauri:build        # production артефакт в src-tauri/target/release/bundle/
```
Production-десктоп ходит на HTTPS-бэкенд `https://185-252-215-73.nip.io` (см. `.env.tauri`).
Web build продолжает использовать `.env.production` (`http://185.252.215.73` через nginx).
```

- [ ] **Step 2: Поправить раздел "Key Technical Details"**

Добавить:
```markdown
- Desktop shell — Tauri v2 (`frontend/src-tauri/`), плагины: `notification`, `single-instance`, `tray-icon` (через feature `tauri/tray-icon`)
- Capabilities — `frontend/src-tauri/capabilities/default.json` (без этого Tauri v2 отказывает в любых API)
- Backend для десктопа — `https://185-252-215-73.nip.io` (Let's Encrypt + nginx + nip.io)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: tauri desktop build + https backend"
```

### Task 7.2: Обновить README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Добавить раздел "Desktop App"** — короткий, как пользователь устанавливает .dmg/.msi.

```markdown
## Desktop App (Tauri)

Производные артефакты:
- macOS: `Telegram Assistant_0.1.0_aarch64.dmg`
- Windows: `Telegram Assistant_0.1.0_x64-setup.exe` (NSIS) или `.msi`

Скачать → открыть → перетащить в Applications (mac) / запустить установщик (win).

При первом запуске на macOS:
- Right-click → Open → "Open anyway" (apps без Apple Developer ID требуют ручного allow)
- В Settings → Notifications → Telegram Assistant — включить уведомления

Десктоп подключается к тому же VPS бэкенду что и веб (`https://185-252-215-73.nip.io`).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: desktop app installation guide"
```

### Task 7.3: Финальный smoke-test (manual checklist)

Проверки на macOS production билд (`.dmg`):
- [ ] Установка через Drag-to-Applications работает
- [ ] При первом запуске после adhoc-allow приложение открывается
- [ ] Авторизация по телефону работает (запрос кода, подтверждение)
- [ ] Список диалогов загружается
- [ ] Открытие диалога, отправка сообщения работает
- [ ] WebSocket — приходят новые сообщения в real-time
- [ ] При новом сообщении — OS уведомление появляется (title=имя, body=текст)
- [ ] Клик по уведомлению фокусит окно и открывает нужный чат
- [ ] Иконка в menu bar (трее) присутствует
- [ ] ЛКМ по иконке — toggle окно
- [ ] ПКМ → Show/Hide/Quit работают
- [ ] × на окне — окно скрывается в трей, процесс не выходит
- [ ] Двойной запуск .app — второе окно не открывается, первое фокусится
- [ ] Quit из трея — процесс полностью завершается

Те же проверки на Windows (`.exe`/`.msi`):
- [ ] Установщик NSIS/MSI запускается, ставит в Program Files
- [ ] Запуск через Start Menu работает
- [ ] Все вышеперечисленные пункты повторяются на Windows

- [ ] **Финальный коммит**

```bash
git add plan/
git commit -m "docs(plan): finalize tauri desktop implementation plan + notes"
```

---

## Self-Review Checklist

### Spec Coverage
- [x] Bind to same VPS backend → Phase 0 (TLS) + Phase 2 (.env.tauri)
- [x] Telegram-style notifications → Phase 3
- [x] Tray icon → Phase 4
- [x] macOS build → Phase 6 Task 6.1
- [x] Windows build → Phase 6 Task 6.2
- [x] Web и Desktop работают одновременно с одним бэкендом → Phase 0/2

### Risks Identified
- **macOS code-signing**: для широкого распространения нужен Apple Developer ID ($99/год). Для личного использования — adhoc OK.
- **Windows SmartScreen**: при первом запуске unsigned .exe пользователь увидит "Windows protected your PC" → "Run anyway". Для production надо подписать сертификатом ($300+/год). Пропущено в плане — это нелогично гнать без bg-задачи "купить cert".
- **WebView2 на Windows**: Tauri использует системный WebView2 (Edge). На Win 10 без апдейтов может отсутствовать — bundler автоматически добавит WebView2 Runtime installer в bootstrapper. NSIS-installer работает out of the box.
- **nip.io rate-limit**: Let's Encrypt лимит 50 certs/неделю на registered-domain `nip.io` суммарно по всем поддоменам. На практике для нас лимит не будет проблемой.

### Placeholder Scan
- Нет TBD/TODO в коде. Все блоки кода — полные, готовы копировать-вставить.
- В Task 3.4 указано "адаптируй под реальную структуру" — это ожидаемо, потому что shape события зависит от backend/main.py, который агент должен прочитать в момент выполнения. Это не плейсхолдер кода — это указание на read-before-write.

### Type Consistency
- `notify()` сигнатура: `{ title, body, chatId?, icon? }` — везде совпадает.
- `getPendingChatId()` экспорт из `useDesktopNotifications.ts` — упомянут и определён.
- Tauri commands не использовали (пока) — нет risk-а несовместимости.

---

## Execution Handoff

Plan saved to `plan/2026-05-13-tauri-desktop.md`. Two execution options:

**1. Subagent-Driven (recommended)** — диспатчим fresh-subagent на каждый Task. Главный агент ревьюит между task'ами. Быстрее, лучше изоляция.

**2. Inline Execution** — выполняем по очереди в этой же сессии с чекпоинтами для ревью.

Выбирай. После выбора начнём с Phase 0 (VPS — нужен SSH-доступ для certbot).
