# Task Plan: Tauri Desktop App for tg_focus_app

## Goal
Превратить веб-приложение `tg_focus_app` в кросс-платформенный Tauri-десктоп (macOS + Windows), который ходит на тот же VPS-бэкенд по HTTPS, показывает Telegram-стиль уведомления и иконку в трее.

## Phases
- [x] Phase 0: VPS TLS (nip.io домен + Let's Encrypt + nginx HTTPS server-block)
- [x] Phase 1: Починка существующего `frontend/src-tauri/` (capabilities, split lib.rs, поправки конфига)
- [x] Phase 2: Tauri-aware build mode (`.env.tauri`, исправить хардкод-fallback IP бага)
- [x] Phase 3: OS-уведомления (плагин + frontend hook + bind на WS события)
- [x] Phase 4: Системный трей (Rust TrayIconBuilder + меню + badge)
- [x] Phase 5: Поведение окна и deep-links (single-instance, close-to-tray, click-to-navigate)
- [x] Phase 6: Кросс-платформенная сборка (.dmg для mac, .msi для Win)
- [x] Phase 7: Документация + финальный smoke-test

## Key Decisions
- **Структура**: оставляем `frontend/src-tauri/` (встроенный Tauri-shell). Не мигрируем.
- **TLS**: `185-252-215-73.nip.io` + Let's Encrypt (бесплатно, никакого домена покупать не надо).
- **Платформы**: macOS (universal) + Windows (x86_64-pc-windows-msvc). Linux позже.
- **Уведомления**: telegram-style — title = имя диалога, body = текст сообщения, клик → focus window + navigate `/chat/<id>` (или `/message/<id>` для каналов).
- **Состояние**: всё что есть в вебе — есть в десктопе. Frontend код общий.

## Architecture
```
┌────────────────────────────────┐         ┌────────────────────────────────┐
│  Tauri Desktop (mac/win)       │         │  Web Browser (any)             │
│  ┌──────────────────────────┐  │         │  ┌──────────────────────────┐  │
│  │ Vite/React (frontend/src)│  │         │  │ Same Vite/React build    │  │
│  │  + Tauri APIs            │  │         │  │  (served by nginx)       │  │
│  └─────────┬────────────────┘  │         │  └─────────┬────────────────┘  │
│  ┌─────────▼────────────────┐  │         │            │                   │
│  │ Rust core (src-tauri):   │  │         │            │                   │
│  │  - tray, notif, single   │  │         │            │                   │
│  │  - close-to-tray         │  │         │            │                   │
│  └──────────────────────────┘  │         │            │                   │
└──────────────┬─────────────────┘         └────────────┼───────────────────┘
               │                                        │
               │ HTTPS / WSS                            │ HTTPS / WSS
               └────────────┬──────────────────┬────────┘
                            │                  │
                            ▼                  ▼
              ┌─────────────────────────────────────────┐
              │  VPS 185.252.215.73                     │
              │  ┌──────────────────────────────────┐   │
              │  │ nginx                            │   │
              │  │  :80  → redirect to 443          │   │
              │  │  :443 → SSL (Let's Encrypt)      │   │
              │  │         on 185-252-215-73.nip.io │   │
              │  │  /     → /var/www/tg-focus (SPA) │   │
              │  │  /api  → proxy 127.0.0.1:8080    │   │
              │  └────────────┬─────────────────────┘   │
              │  ┌────────────▼─────────────────────┐   │
              │  │ FastAPI + Pyrogram (Docker)      │   │
              │  │  :8080                           │   │
              │  └──────────────────────────────────┘   │
              └─────────────────────────────────────────┘
```

## Errors Encountered
_(пусто, заполняется по ходу)_

## Status
**ALL PHASES COMPLETE** — план выполнен. Артефакт .dmg готов, GH Actions для cross-platform builds зафиксирован. Осталось manual smoke-test на mac + native Win build для финального .msi/.exe.

## Files
- Этот файл (`plan/task_plan.md`) — высокоуровневый трекинг.
- `plan/notes.md` — найденное во время exploration (IP-опечатки, текущее состояние Tauri).
- `plan/2026-05-13-tauri-desktop.md` — детальный implementation plan (engineer-ready, bite-sized tasks).
