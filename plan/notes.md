# Notes: текущее состояние перед началом Tauri-десктоп работ

## Что уже есть

### Tauri shell (frontend/src-tauri/)
- Tauri **v2** уже инициализирован
- `Cargo.toml`: `tauri ^2`, `tauri-plugin-shell ^2`, `serde 1`, `serde_json 1`
- `tauri.conf.json`: identifier `tg.assistant`, productName "Telegram Assistant", devUrl `:5173`, frontendDist `../dist`, окно 1200×800
- `src/main.rs`: голый, только `tauri::Builder::default().plugin(tauri_plugin_shell::init()).run(...)`
- НЕТ `capabilities/` директории
- НЕТ `lib.rs` (всё в main.rs — несовместимо с будущим mobile)
- Иконки полные: `.icns`, `.ico`, PNG + Win Store Squares + android/ios плейсхолдеры

### Frontend (frontend/)
- Vite + React + TS, `vite.config.ts` уже умеет в Tauri-режим (`VITE_TAURI=1` → `base = "./"`)
- `package.json` имеет scripts `tauri:dev`, `tauri:build`, девзависимость `@tauri-apps/cli ^2`
- НЕТ `@tauri-apps/api` в dependencies (нужно установить)
- НЕТ `@tauri-apps/plugin-notification` (нужно установить)

### Backend & VPS
- VPS: `185.252.215.73` (Ubuntu 24.04, root, ssh уже работает)
- nginx-конфиг `ops/nginx/tg-focus.conf` — слушает только `:80`, SPA + проксирование к `127.0.0.1:8080`
- Backend Docker на порту `:8080`, healthz `/healthz`
- WebSocket уже работает через nginx Upgrade-header

## Найденные баги (исправим попутно)

### БАГ-1: Опечатка IP в `frontend/src-tauri/tauri.conf.json`
```json
"macOS": { "exceptionDomain": "185.250.149.23" }
```
**Должно быть**: `185.252.215.73` (либо вообще убираем после перехода на HTTPS).

### БАГ-2: Опечатка IP в `frontend/src/services/telegramApi.ts:18`
```ts
this.baseUrl = (envBase && envBase.trim()) || 'http://185.250.149.23:8080';
```
Fallback на несуществующий IP. В проде маскируется наличием `VITE_API_BASE_URL` в `.env.production`, но всё равно опасно. Заменим на корректный hostname или удалим fallback (пусть будет relative).

### БАГ-3: `.env.local` указывает на чужой IP
```
VITE_API_BASE_URL=http://94.131.109.193:8080
```
Это, по-видимому, другой сервер. Локалка трогать не будем (не наша задача), но отметим.

## Архитектурные ограничения

- **Tauri v2 + capabilities-first**: без явных permissions ничего не работает (notif, http, tray). Это не баг, это feature.
- **Cross-compile c Mac на Win — нерекомендуем**: проще собрать Windows-артефакт на Windows VM (Parallels/UTM) или GitHub Actions workflow `windows-latest`.
- **macOS code-signing**: для распространения нужен Apple Developer ID. Для самосбора и личного использования — adhoc подпись подойдёт (uname приходит как "unidentified developer", обходится правым кликом → Open).
- **nip.io ограничения**: бесплатный wildcard, без проблем для Let's Encrypt rate-limit (5 certs/неделя на регистрируемый домен — 185-252-215-73.nip.io это отдельный subdomain, своя квота).
- **WebSocket reconnect**: на десктопе пользователь может убрать window в трей → JS-таймер замедлится в фоне, но WS должен переподключаться. Нужно проверить во время smoke-теста.

## Решения уже принятые с пользователем
1. Структура: `frontend/src-tauri/` (встроенный, не отдельная папка)
2. TLS: nip.io + Let's Encrypt
3. Платформы: macOS + Windows
4. Уведомления: Telegram-style 1:1 + иконка трея

## Сторонние ссылки (для агента-исполнителя)
- Tauri v2 plugin-notification: https://v2.tauri.app/plugin/notification/
- Tauri v2 system-tray (TrayIconBuilder): https://v2.tauri.app/learn/window-customization/#system-tray
- Tauri v2 capabilities: https://v2.tauri.app/security/capabilities/
- nip.io: http://nip.io/ — DNS wildcard, `<ip-with-dashes>.nip.io` всегда возвращает указанный IP
- certbot --nginx: https://certbot.eff.org/instructions?ws=nginx&os=ubuntufocal
