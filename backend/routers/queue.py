"""Queue endpoints: list and act on pending chats."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.folder_service import FolderService
from services.queue_service import QueueService

logger = logging.getLogger(__name__)


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
    folder_service: FolderService,
) -> APIRouter:
    router = APIRouter()

    @router.get("/queue")
    async def get_queue(account: str = "", meta: bool = False):
        order = await queue_service.get(account)
        if not meta:
            return {"queue": order}

        try:
            payload = await folder_service.get_folders(account=account)
        except Exception:
            logger.warning("FolderService.get_folders failed", exc_info=True)
            payload = {"chat_to_folders": {}}
        c2f = payload.get("chat_to_folders", {})
        return {
            "queue": [
                {"chat_id": cid, "folder_ids": list(c2f.get(cid, []))}
                for cid in order
            ]
        }

    @router.post("/queue/action")
    async def queue_action(payload: dict[str, Any]):
        import time

        chat_id = payload.get("chat_id")
        action = str(payload.get("action", "")).lower()
        valid = {"done", "postpone", "task", "snooze", "skip"}
        if chat_id is None or action not in valid:
            raise HTTPException(status_code=400, detail="chat_id and valid action are required")

        account = str(payload.get("account", "")).strip()

        if action == "done":
            try:
                client = manager.get_or_create(account) if account else manager.default
                await manager.ensure_connected(client)
                await client.read_chat_history(chat_id)
            except Exception:
                logger.warning("read_chat_history failed", exc_info=True)
            await queue_service.remove(account, chat_id)
        elif action == "snooze":
            until_raw = payload.get("snooze_until")
            if until_raw is None:
                raise HTTPException(status_code=400, detail="snooze_until is required")
            try:
                until_ts = int(until_raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="snooze_until must be int")
            if until_ts <= int(time.time()):
                raise HTTPException(status_code=400, detail="snooze_until must be in the future")
            await queue_service.snooze(account, chat_id, until_ts=until_ts)
        else:
            # postpone / task / skip — all move to end without changing unread
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}

    return router
