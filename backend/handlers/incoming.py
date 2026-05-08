"""Factory for Pyrogram incoming-message handlers.

This phase keeps the existing private-only filter — group support arrives in
Plan 2 alongside folder filtering.
"""
from __future__ import annotations

from typing import Any

from pyrogram import Client
from pyrogram.types import Message

from services.media_utils import extract_media_info
from services.queue_service import QueueService
from ws.broadcaster import Broadcaster


def make_incoming_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
):
    async def handler(client: Client, message: Message) -> None:
        try:
            ctype = getattr(message.chat, "type", None)
            type_name = (
                getattr(ctype, "value", None)
                or (str(ctype).lower() if ctype is not None else "")
            )
        except Exception:
            type_name = ""
        if type_name != "private":
            return

        chat_id = message.chat.id
        await queue_service.add(account, chat_id)
        await broadcaster.broadcast(
            {"type": "queue_update", "account": account, "chat_id": chat_id}
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
                    "message": payload,
                }
            )

    return handler


def _format_author(message: Message) -> str | None:
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
        return None
    return None
