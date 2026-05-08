"""Pyrogram handler: outgoing messages → remove chat from queue.

Mirrors handlers/incoming.py but listens on filters.outgoing. When the user
sends (or sends-from-another-device) a message in a chat that is currently
in the queue, the chat is considered handled and removed.
"""
from __future__ import annotations

import logging

from pyrogram import Client
from pyrogram.types import Message

from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

_ACCEPTED_TYPES = ("private", "group", "supergroup")


def make_outgoing_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
    queue_meta_cache=None,
):
    async def handler(client: Client, message: Message) -> None:
        try:
            ctype = getattr(message.chat, "type", None)
            type_name = (
                getattr(ctype, "value", None)
                or (str(ctype).lower() if ctype is not None else "")
            )
        except Exception:
            logger.debug("type detection failed", exc_info=True)
            return
        if type_name not in _ACCEPTED_TYPES:
            return

        chat_id = message.chat.id
        order = await queue_service.get(account)
        if chat_id not in order:
            return

        await queue_service.remove(account, chat_id)
        if queue_meta_cache is not None:
            try:
                queue_meta_cache.invalidate(account, chat_id)
            except Exception:
                logger.debug("queue meta cache invalidate failed", exc_info=True)

        await broadcaster.broadcast(
            {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "removed": True,
            }
        )

    return handler
