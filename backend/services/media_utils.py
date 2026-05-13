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


def extract_forward_info(message) -> dict:
    """Return a dict describing forwarded-message metadata, or {} if not forwarded.

    Pyrogram exposes several forward attributes (forward_from for a user origin,
    forward_from_chat for a channel origin, forward_sender_name for users who
    hide their identity, and forward_date as a datetime). We normalize them
    into a stable shape the frontend can render.
    """
    if not getattr(message, "forward_date", None):
        return {}

    name: str | None = None
    fwd_from = getattr(message, "forward_from", None)
    if fwd_from is not None:
        first = getattr(fwd_from, "first_name", "") or ""
        last = getattr(fwd_from, "last_name", "") or ""
        full = (first + (" " + last if last else "")).strip()
        if full:
            name = full

    if name is None:
        fwd_chat = getattr(message, "forward_from_chat", None)
        if fwd_chat is not None:
            chat_title = getattr(fwd_chat, "title", None)
            if chat_title:
                name = chat_title

    if name is None:
        sender_name = getattr(message, "forward_sender_name", None)
        if sender_name:
            name = sender_name

    fwd_date = getattr(message, "forward_date", None)
    try:
        fwd_ts = int(fwd_date.timestamp()) if fwd_date else None
    except Exception:
        fwd_ts = None

    out: dict = {"forwarded": True}
    if name:
        out["forward_from_name"] = name
    if fwd_ts is not None:
        out["forward_date"] = fwd_ts
    return out
