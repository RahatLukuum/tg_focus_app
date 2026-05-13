"""Factory for Pyrogram incoming-message handlers.

Accepts private + group + supergroup chats. Channels (broadcast) and archived
chats are skipped. Forum-supergroup messages also carry topic_id and
topic_title (best-effort, from TopicsService cache).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from pyrogram import Client
from pyrogram.types import Message

from services.folder_service import FolderService
from services.media_utils import extract_forward_info, extract_media_info
from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

_ACCEPTED_TYPES = ("private", "group", "supergroup")


def make_incoming_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
    folder_service: FolderService,
    topics_service: Optional[Any] = None,
    queue_meta_cache: Optional[Any] = None,
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
            type_name = ""
        if type_name not in _ACCEPTED_TYPES:
            return

        chat_id = message.chat.id
        if folder_service.is_archived(account, chat_id):
            return

        await queue_service.add(account, chat_id)
        if queue_meta_cache is not None:
            try:
                queue_meta_cache.invalidate(account, chat_id)
            except Exception:
                logger.debug("queue_meta_cache invalidate failed", exc_info=True)

        topic_id = getattr(message, "message_thread_id", None)
        topic_id_int = int(topic_id) if topic_id else None
        topic_title: Optional[str] = None
        if topic_id_int is not None and topics_service is not None:
            try:
                topic_title = await topics_service.get_topic_title(
                    account=account, chat_id=chat_id, topic_id=topic_id_int
                )
            except Exception:
                topic_title = None

        folder_ids = folder_service.get_cached_chat_folders(account, chat_id)
        await broadcaster.broadcast(
            {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "folder_ids": folder_ids,
                "topic_id": topic_id_int,
            }
        )

        preview_text = (message.text or message.caption or "").strip()
        media_info = extract_media_info(message)
        author = _format_author(message)

        if preview_text or media_info:
            payload: dict[str, Any] = {
                "id": message.id,
                "text": preview_text,
                "date": int(message.date.timestamp()) if message.date else None,
                "from_user_id": message.from_user.id if message.from_user else None,
                "from_user_name": author,
                "outgoing": message.outgoing,
            }
            payload.update(media_info)
            payload.update(extract_forward_info(message))
            chat_title = (
                message.chat.title
                if getattr(message.chat, "title", None)
                else (author or "")
            )
            await broadcaster.broadcast(
                {
                    "type": "message",
                    "account": account,
                    "chat_id": chat_id,
                    "chat_title": chat_title,
                    "topic_id": topic_id_int,
                    "topic_title": topic_title,
                    "message": payload,
                }
            )

    return handler


def _format_author(message: Message) -> Optional[str]:
    try:
        if message.from_user:
            first = message.from_user.first_name or ""
            last = (
                f" {message.from_user.last_name}"
                if message.from_user.last_name
                else ""
            )
            return (first + last).strip() or None
        if message.sender_chat:
            return message.sender_chat.title
    except Exception:
        logger.debug("author lookup failed", exc_info=True)
    return None
