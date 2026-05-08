"""FastAPI app entrypoint.

All endpoint logic lives in routers/. Services hold state. Handlers wire up
Pyrogram callbacks. This file's job is composition only.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pyrogram import filters
from pyrogram.handlers import MessageHandler

from config import load_config
from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from handlers.incoming import make_incoming_handler
from handlers.outgoing import make_outgoing_handler
from routers import ai as ai_router
from routers import auth as auth_router
from routers import dialogs as dialogs_router
from routers import folders as folders_router
from routers import messages as messages_router
from routers import queue as queue_router
from routers import tasks as tasks_router
from routers import topics as topics_router
from services.claude_client import ClaudeClient, ClaudeConfig
from services.folder_service import FolderService
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService
from services.snooze_worker import start_snooze_worker
from services.state_store import JsonStore
from services.task_store import TaskStore
from services.topics_service import TopicsService
from ws.broadcaster import broadcaster

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Build and return the FastAPI application."""
    cfg = load_config()
    manager = PyrogramClientManager(cfg)
    queue_state_store = JsonStore(
        cfg.session_dir / "queue_state.json",
        default_factory=lambda: {"queues": {}, "snoozed": {}},
    )
    queue_service = QueueService(store=queue_state_store)
    folder_service = FolderService(manager)
    topics_service = TopicsService(manager)
    queue_meta_cache = QueueMetaCache(ttl_seconds=30)
    auth_deps = AuthDeps(manager)

    # Wire incoming handler factory once.
    manager.set_incoming_handler_factory(
        lambda client, account: make_incoming_handler(
            queue_service=queue_service, broadcaster=broadcaster, account=account,
            folder_service=folder_service, topics_service=topics_service,
            queue_meta_cache=queue_meta_cache,
        )
    )
    manager.set_outgoing_handler_factory(
        lambda client, account: make_outgoing_handler(
            queue_service, broadcaster, account, queue_meta_cache=queue_meta_cache,
        )
    )

    # Attach handler to default client too (it doesn't go through get_or_create).
    _default_handler = make_incoming_handler(
        queue_service=queue_service, broadcaster=broadcaster, account="",
        folder_service=folder_service, topics_service=topics_service,
        queue_meta_cache=queue_meta_cache,
    )
    manager.default.add_handler(
        MessageHandler(_default_handler, filters.incoming & ~filters.service)
    )
    # Default-account outgoing handler (mirrors the default-account incoming wiring above).
    _default_out_handler = make_outgoing_handler(
        queue_service, broadcaster, "", queue_meta_cache=queue_meta_cache,
    )
    manager.default.add_handler(
        MessageHandler(_default_out_handler, filters.outgoing & ~filters.service)
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
        await queue_service.load()
        worker = start_snooze_worker(queue_service, broadcaster)
        try:
            yield
        finally:
            worker.cancel()
            try:
                await worker
            except (asyncio.CancelledError, Exception):
                pass
            await manager.stop_all()
            if claude_client is not None:
                try:
                    await claude_client.aclose()
                except Exception:
                    logger.warning("claude_client.aclose() failed", exc_info=True)

    app = FastAPI(title="TG Backend API", lifespan=lifespan)

    # Determine CORS settings: explicit origins → credentials allowed.
    # No origins configured → permissive but no credentials (browser-safe).
    if cfg.cors_allowed_origins:
        cors_origins = list(cfg.cors_allowed_origins)
        cors_credentials = True
    else:
        cors_origins = ["*"]
        cors_credentials = False

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=cors_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth_router.make_router(manager))
    app.include_router(dialogs_router.make_router(manager, auth_deps, queue_service, folder_service))
    app.include_router(messages_router.make_router(manager, auth_deps))
    app.include_router(
        queue_router.make_router(
            manager=manager,
            auth=auth_deps,
            queue_service=queue_service,
            folder_service=folder_service,
            topics_service=topics_service,
            queue_meta_cache=queue_meta_cache,
        )
    )
    app.include_router(tasks_router.make_router(task_store))
    app.include_router(folders_router.make_router(folder_service))
    app.include_router(ai_router.make_router(claude_client, auth_deps))
    app.include_router(topics_router.make_router(topics_service=topics_service, auth=auth_deps))

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
                "/folders",
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
            logger.warning("WebSocket loop error", exc_info=True)
        finally:
            broadcaster.remove(ws)

    try:
        DIST_DIR = (Path(__file__).parent / "frontend" / "dist").resolve()
        if DIST_DIR.exists():
            app.mount("/app", StaticFiles(directory=str(DIST_DIR), html=True), name="app")
    except Exception:
        logger.warning("Failed to mount /app static dir", exc_info=True)

    # SPA fallback: any GET that didn't match an API route or static mount
    # falls back to the SPA index.html. Defense-in-depth for cases where the
    # backend is hit directly without nginx in front.
    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        from fastapi import HTTPException
        from fastapi.responses import FileResponse
        from starlette.routing import Match

        request_path = "/" + full_path
        # If FastAPI has a registered route that matches this path for ANY
        # method, treat it as an API path and return 404 — never serve SPA
        # for paths that "should have" been an API endpoint.
        for route in app.routes:
            matcher = getattr(route, "matches", None)
            if matcher is None:
                continue
            scope = {
                "type": "http",
                "path": request_path,
                "method": "GET",
                "query_string": b"",
                "root_path": "",
            }
            try:
                match, _ = matcher(scope)
            except Exception:
                continue
            if match == Match.FULL and route.endpoint is not spa_fallback:
                # Path collides with a registered route — let FastAPI's normal
                # routing return whatever it would (likely 405/404).
                raise HTTPException(status_code=404)

        index = Path(__file__).parent / "frontend" / "dist" / "index.html"
        if not index.exists():
            raise HTTPException(status_code=404)
        return FileResponse(str(index))

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
