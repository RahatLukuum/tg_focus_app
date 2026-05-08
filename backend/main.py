"""FastAPI app entrypoint.

All endpoint logic lives in routers/. Services hold state. Handlers wire up
Pyrogram callbacks. This file's job is composition only.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import load_config
from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from handlers.incoming import make_incoming_handler
from routers import ai as ai_router
from routers import auth as auth_router
from routers import dialogs as dialogs_router
from routers import messages as messages_router
from routers import queue as queue_router
from routers import tasks as tasks_router
from services.claude_client import ClaudeClient, ClaudeConfig
from services.queue_service import QueueService
from services.state_store import JsonStore
from services.task_store import TaskStore
from ws.broadcaster import broadcaster

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

cfg = load_config()
manager = PyrogramClientManager(cfg)
queue_service = QueueService()
auth_deps = AuthDeps(manager)

# Wire incoming handler factory once.
manager.set_incoming_handler_factory(
    lambda client, account: make_incoming_handler(queue_service, broadcaster, account)
)

# Attach handler to default client too (it doesn't go through get_or_create).
from pyrogram import filters as _filters
from pyrogram.handlers import MessageHandler as _MessageHandler

_default_handler = make_incoming_handler(queue_service, broadcaster, "")
manager.default.add_handler(
    _MessageHandler(_default_handler, _filters.incoming & ~_filters.service)
)

# State stores.
tasks_json = JsonStore(cfg.session_dir / "tasks.json", default_factory=list)
task_store = TaskStore(tasks_json)

# Optional Claude client.
claude_client: ClaudeClient | None = None
if cfg.anthropic_api_key:
    claude_client = ClaudeClient(ClaudeConfig(api_key=cfg.anthropic_api_key))


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await manager.stop_all()


app = FastAPI(title="TG Backend API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.make_router(manager))
app.include_router(dialogs_router.make_router(manager, auth_deps, queue_service))
app.include_router(messages_router.make_router(manager, auth_deps))
app.include_router(queue_router.make_router(manager, auth_deps, queue_service))
app.include_router(tasks_router.make_router(task_store))
app.include_router(ai_router.make_router(claude_client, auth_deps))


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "service": "TG Backend API",
        "status": "ok",
        "docs": "/docs",
        "endpoints": [
            "/auth/send_code",
            "/auth/sign_in",
            "/me",
            "/dialogs",
            "/messages",
            "/send_message",
            "/queue",
            "/queue/action",
            "/tasks",
            "/generate_reply",
            "/ws",
        ],
    }


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    broadcaster.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        broadcaster.remove(ws)


# Serve built frontend at /app for SPA mode (mounted last so router paths win).
try:
    DIST_DIR = (Path(__file__).parent / "frontend" / "dist").resolve()
    if DIST_DIR.exists():
        app.mount("/app", StaticFiles(directory=str(DIST_DIR), html=True), name="app")
except Exception:
    pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
