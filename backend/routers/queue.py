"""Queue endpoints: list and act on pending chats."""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.folder_service import FolderService
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService
from services.topics_service import TopicsService

logger = logging.getLogger(__name__)


def _format_author(m) -> Optional[str]:
    if getattr(m, "from_user", None):
        first = getattr(m.from_user, "first_name", None) or ""
        last = getattr(m.from_user, "last_name", None) or ""
        return (first + (" " + last if last else "")).strip() or None
    if getattr(m, "sender_chat", None):
        return getattr(m.sender_chat, "title", None)
    return None


async def _fetch_last_message(
    client, chat_id: int, topics_service: TopicsService, account: str
) -> Optional[dict[str, Any]]:
    try:
        result = client.get_chat_history(chat_id, limit=1)
        if inspect.iscoroutine(result):
            result = await result
        async for m in result:
            text = (getattr(m, "text", None) or getattr(m, "caption", None) or "").strip() or None
            topic_id = getattr(m, "message_thread_id", None)
            return {
                "id": getattr(m, "id", 0),
                "text": text,
                "from_name": _format_author(m) if not getattr(m, "outgoing", False) else None,
                "outgoing": bool(getattr(m, "outgoing", False)),
                "date": int(m.date.timestamp()) if getattr(m, "date", None) else None,
                "topic_id": int(topic_id) if topic_id else None,
            }
    except Exception:
        logger.debug("get_chat_history(limit=1) failed for chat %s", chat_id, exc_info=True)
    return None


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
    folder_service: FolderService,
    topics_service: TopicsService,
    queue_meta_cache: QueueMetaCache,
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
        snoozed = await queue_service.snoozed(account)

        # Resolve last_message per chat: try cache; fall back to one Pyrogram call each.
        client = manager.get_or_create(account) if account else manager.default

        async def _resolve(cid: int) -> dict[str, Any]:
            cached = queue_meta_cache.get(account, cid)
            if cached is not None:
                last = cached
            else:
                if client is not None:
                    try:
                        await manager.ensure_connected(client)
                    except Exception:
                        pass
                last = await _fetch_last_message(client, cid, topics_service, account) if client else None
                if last is not None:
                    queue_meta_cache.set(account, cid, last)
            topic_id = last.get("topic_id") if last else None
            topic_title = None
            if topic_id is not None:
                try:
                    topic_title = await topics_service.get_topic_title(
                        account=account, chat_id=cid, topic_id=int(topic_id)
                    )
                except Exception:
                    topic_title = None
            return {
                "chat_id": cid,
                "folder_ids": list(c2f.get(cid, [])),
                "snooze_until": None,
                "topic_id": topic_id,
                "topic_title": topic_title,
                "last_message": last,
            }

        items = await asyncio.gather(*[_resolve(cid) for cid in order])
        return {
            "queue": items,
            "snoozed": [
                {"chat_id": cid, "snooze_until": ts}
                for cid, ts in sorted(snoozed.items(), key=lambda kv: kv[1])
            ],
        }

    @router.post("/queue/action")
    async def queue_action(payload: dict[str, Any]):
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
            queue_meta_cache.invalidate(account, int(chat_id))
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
            queue_meta_cache.invalidate(account, int(chat_id))
        else:
            # postpone / task / skip — all move to end without changing unread
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}

    return router
