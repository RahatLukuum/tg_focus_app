"""Pyrogram raw-update handler: read receipts → remove chat from queue.

When the user reads a chat on another device (mobile, Telegram web, etc.),
Telegram broadcasts UpdateReadHistoryInbox (for users and basic groups) or
UpdateReadChannelInbox (for supergroups/channels) to all connected clients.

This handler listens for those updates and, if the chat has no remaining
unread messages, drops it from the in-memory queue. Without this, chats stay
in the queue forever after being read elsewhere.
"""
from __future__ import annotations

import logging

from pyrogram import Client
from pyrogram.raw.types import (
    UpdateReadChannelInbox,
    UpdateReadHistoryInbox,
)

from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

# Telegram supergroup/channel canonical id = -100<bare_channel_id>.
# This constant + subtraction matches pyrogram.utils.get_peer_id() output.
_CHANNEL_ID_PREFIX = -1_000_000_000_000


def _resolve_chat_id(update) -> int | None:
    """Return canonical chat_id for a read-inbox update, or None if unknown."""
    if isinstance(update, UpdateReadChannelInbox):
        try:
            return _CHANNEL_ID_PREFIX - int(update.channel_id)
        except Exception:
            return None
    if isinstance(update, UpdateReadHistoryInbox):
        peer = update.peer
        # PeerUser → user_id (positive)
        user_id = getattr(peer, "user_id", None)
        if user_id is not None:
            return int(user_id)
        # PeerChat → basic group, chat_id is negative (no -100 prefix)
        chat_id = getattr(peer, "chat_id", None)
        if chat_id is not None:
            return -int(chat_id)
        # PeerChannel (rare in UpdateReadHistoryInbox but possible)
        channel_id = getattr(peer, "channel_id", None)
        if channel_id is not None:
            return _CHANNEL_ID_PREFIX - int(channel_id)
    return None


def make_read_inbox_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
    queue_meta_cache=None,
):
    async def handler(client: Client, update, users, chats) -> None:
        if not isinstance(update, (UpdateReadHistoryInbox, UpdateReadChannelInbox)):
            return

        still_unread = getattr(update, "still_unread_count", None)
        if still_unread is None or still_unread > 0:
            return  # there are still unread messages — keep in queue

        chat_id = _resolve_chat_id(update)
        if chat_id is None:
            return

        order = await queue_service.get(account)
        if chat_id not in order:
            return

        await queue_service.remove(account, chat_id)
        if queue_meta_cache is not None:
            try:
                queue_meta_cache.invalidate(account, chat_id)
            except Exception:
                logger.debug("queue_meta_cache invalidate failed", exc_info=True)

        await broadcaster.broadcast(
            {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "removed": True,
            }
        )

    return handler
