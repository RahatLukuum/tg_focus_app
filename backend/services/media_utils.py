"""Media metadata extraction shared between message handler and history endpoint."""
from __future__ import annotations

from typing import Any, Optional

from pyrogram.types import Message


def extract_media_info(message: Message, *, chat_id: Optional[int] = None) -> dict[str, Any]:
    """Return media_type/media_url/file_name/duration if present, else empty dict.

    chat_id can be passed to override message.chat.id (used by handler that wants
    the chat that delivered the message even on forwards).
    """
    media_type: Optional[str] = None
    file_name: Optional[str] = None
    duration: Optional[int] = None

    if message.photo:
        media_type = "photo"
    elif message.video:
        media_type = "video"
        duration = getattr(message.video, "duration", None)
        file_name = getattr(message.video, "file_name", None)
    elif message.voice:
        media_type = "voice"
        duration = getattr(message.voice, "duration", None)
    elif message.video_note:
        media_type = "video"
        duration = getattr(message.video_note, "duration", None)
    elif message.document:
        media_type = "document"
        file_name = getattr(message.document, "file_name", None)

    if not media_type:
        return {}

    cid = chat_id if chat_id is not None else message.chat.id
    result: dict[str, Any] = {
        "media_type": media_type,
        "media_url": f"/media/{cid}/{message.id}",
    }
    if file_name:
        result["file_name"] = file_name
    if duration is not None:
        result["duration"] = duration
    return result
