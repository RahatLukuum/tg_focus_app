"""Background worker that restores snoozed chats when their snooze expires."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

CHECK_INTERVAL_SECONDS = 30


async def _tick(queue_service: QueueService, broadcaster: Broadcaster) -> None:
    now = int(time.time())
    try:
        restored = await queue_service.expire_snoozed(now_ts=now)
    except Exception:
        logger.warning("expire_snoozed failed", exc_info=True)
        return
    for account, chat_ids in restored.items():
        for chat_id in chat_ids:
            event: dict[str, Any] = {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "reason": "snooze_resumed",
            }
            try:
                await broadcaster.broadcast(event)
            except Exception:
                logger.warning("broadcast snooze_resumed failed", exc_info=True)


def start_snooze_worker(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    *,
    interval_seconds: int = CHECK_INTERVAL_SECONDS,
) -> asyncio.Task:
    """Start the worker as a background task. Cancel the returned Task to stop."""

    async def _run() -> None:
        while True:
            await _tick(queue_service, broadcaster)
            await asyncio.sleep(interval_seconds)

    return asyncio.create_task(_run())
