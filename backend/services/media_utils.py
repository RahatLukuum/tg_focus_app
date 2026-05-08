"""Media metadata extraction shared between message handler and history endpoint."""
from __future__ import annotations

from typing import Any, Optional

from pyrogram.types import Message


def extract_media_info(message: Message, *, chat_id: Optional[int] = None) -> dict[str, Any]:
    """Return media_type/media_url/file_name/duration/file_size/mime_type if present.

    Branch order: photo → video → voice → video_note → audio → document.
    `audio` is checked BEFORE `document` because Pyrogram exposes audio files
    on a dedicated `message.audio` attribute that we want to preserve.
    """
    media_type: Optional[str] = None
    file_name: Optional[str] = None
    duration: Optional[int] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None

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
        media_type = "video_note"
        duration = getattr(message.video_note, "duration", None)
    elif getattr(message, "audio", None):
        media_type = "audio"
        duration = getattr(message.audio, "duration", None)
        file_name = getattr(message.audio, "file_name", None)
        mime_type = getattr(message.audio, "mime_type", None)
        file_size = getattr(message.audio, "file_size", None)
    elif message.document:
        media_type = "document"
        file_name = getattr(message.document, "file_name", None)
        file_size = getattr(message.document, "file_size", None)
        mime_type = getattr(message.document, "mime_type", None)

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
    if file_size is not None:
        result["file_size"] = file_size
    if mime_type:
        result["mime_type"] = mime_type
    return result
