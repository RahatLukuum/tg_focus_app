"""Queue endpoints: list and act on pending chats."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.queue_service import QueueService


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
) -> APIRouter:
    router = APIRouter()

    @router.get("/queue")
    async def get_queue(account: str = ""):
        return {"queue": await queue_service.get(account)}

    @router.post("/queue/action")
    async def queue_action(payload: dict[str, Any]):
        chat_id = payload.get("chat_id")
        action = str(payload.get("action", "")).lower()
        if chat_id is None or action not in {"done", "postpone", "task"}:
            raise HTTPException(status_code=400, detail="chat_id and valid action are required")

        account = str(payload.get("account", "")).strip()
        if action == "done":
            try:
                client = manager.get_or_create(account) if account else manager.default
                await manager.ensure_connected(client)
                await client.read_chat_history(chat_id)
            except Exception:
                pass
            await queue_service.remove(account, chat_id)
        else:
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}

    return router
