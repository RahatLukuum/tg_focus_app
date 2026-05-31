# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram Assistant App — a wrapper over Telegram providing: phone-based auth, dialog list, messaging, incoming message queue processing, and real-time updates via WebSocket. Multi-account support included.

## Architecture

**Backend** (`backend/main.py`): Single-file FastAPI server using Pyrogram (Telegram MTProto client). All state (queues, connected WebSocket clients, multi-account sessions) is kept in-memory. Key patterns:
- `bot` — default Pyrogram Client for the primary account configured via `LOGIN` env var
- `clients: Dict[str, Client]` — per-account Pyrogram clients keyed by phone number
- Queue system: in-memory ordered lists per account, populated by incoming private messages
- WebSocket broadcast to all connected frontend clients on new messages/queue updates
- Claude API integration (`/generate_reply`) for AI-assisted reply generation

**Frontend** (`frontend/`): Vite + React + TypeScript + shadcn/ui + Tailwind CSS. Optional Tauri desktop shell.
- Pages: Auth → Home → Chat/Message/Queue/Todo
- `src/services/telegramApi.ts` — HTTP client for the backend API
- `src/contexts/TelegramContext.tsx` — global state (auth, dialogs, queue, WebSocket connection)
- Path alias: `@/` → `src/`
- В режиме Tauri (десктоп) тот же код собирается через `vite build --mode tauri` (см. `frontend/.env.tauri`) — base path `./` вместо `/`, API на HTTPS-домене.

**Deploy** (`deploy.sh`): Pushes to `denis-branch`, SSH into VPS, rebuilds Docker backend, builds frontend with `npm ci && npm run build`, copies dist to nginx webroot.

## Development Commands

### Backend
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```
Requires `backend/.env` with `API_ID`, `API_HASH`, `LOGIN` (and optionally `ANTHROPIC_API_KEY`, proxy settings).

### Frontend
```bash
cd frontend
npm install
npm run dev          # dev server on :5173
npm run build        # production build → dist/
npm run lint         # eslint
```
Set `VITE_API_BASE_URL=http://localhost:8080` in `frontend/.env.local` for local dev.

### Desktop (Tauri)
```bash
cd frontend
# (deps already installed via npm install above)
npm run tauri:dev          # dev окно с hot-reload фронта
npm run tauri:build        # production артефакт в src-tauri/target/release/bundle/
```
Production десктоп ходит на HTTPS-бэкенд `https://194-62-42-159.nip.io` (см. `frontend/.env.tauri`).
Web-build продолжает использовать `frontend/.env.production` (HTTP, через nginx-редирект на HTTPS).

### Docker (backend only)
```bash
cd backend
docker compose up --build
```
Backend available at `http://localhost:8080`, health check: `GET /healthz`.

### Deploy to VPS
```bash
./deploy.sh
```

## Key Technical Details

- Backend uses **Pyrogram** (not Telethon, despite README mention) — MTProto client with async support
- Session files stored in `backend/sessions/` (`.session` files, persisted via Docker volume)
- Frontend base path is configurable via `VITE_BASE` env var (for nginx subpath or Tauri)
- CORS is fully open (`allow_origins=["*"]`) — intended for development/internal use
- No database — all queue/state is ephemeral and reset on backend restart
- Desktop shell — Tauri v2 (`frontend/src-tauri/`), плагины: `tauri-plugin-shell`, `tauri-plugin-notification`, `tauri-plugin-single-instance`, нативный tray через feature `tauri/tray-icon`
- Tauri capabilities в `frontend/src-tauri/capabilities/default.json` — без этого Tauri v2 отказывает в любых API
- Backend для десктопа — `https://194-62-42-159.nip.io` (Let's Encrypt + nginx + nip.io DNS wildcard); web и desktop ходят на один и тот же бэкенд
- Desktop sandbox path для уведомлений: см. `frontend/src/hooks/useDesktopNotifications.ts`
- Deep-link с уведомления через `frontend/src/components/DeepLinkHandler.tsx` (focus event → pending chatId → navigate)
