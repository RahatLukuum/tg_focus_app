"""Message history, send, media (download/upload)."""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pyrogram import Client

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.media_utils import extract_forward_info, extract_media_info

logger = logging.getLogger(__name__)


def _format_sender(m) -> Optional[str]:
    if m.from_user:
        first = getattr(m.from_user, "first_name", None) or ""
        last = getattr(m.from_user, "last_name", None) or ""
        return (first + (" " + last if last else "")).strip() or None
    if getattr(m, "sender_chat", None):
        return getattr(m.sender_chat, "title", None)
    return None


def make_router(manager: PyrogramClientManager, auth: AuthDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/messages")
    async def get_messages(
        chat_id: int,
        limit: int = 50,
        before_id: Optional[int] = None,
        topic_id: Optional[int] = None,
        account: str = "",
    ):
        client = await auth.get_authorized_client(account)
        me_id: Optional[int] = None
        try:
            me = getattr(client, "me", None) or await client.get_me()
            me_id = int(getattr(me, "id", 0) or 0)
        except Exception:
            logger.debug("get_me failed in /messages", exc_info=True)
        is_self_chat = me_id is not None and int(chat_id) == me_id

        history: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"limit": limit}
        if before_id:
            # Pyrogram's get_chat_history uses offset_id to start strictly
            # OLDER than the given message id (does not include offset_id itself).
            try:
                kwargs["offset_id"] = int(before_id)
            except Exception:
                logger.debug("invalid before_id value %r, ignoring", before_id, exc_info=True)
        if topic_id is not None:
            kwargs["message_thread_id"] = int(topic_id)
        async for m in client.get_chat_history(chat_id, **kwargs):
            text_content = (m.text or m.caption or "").strip()
            media_info = extract_media_info(m, chat_id=chat_id)
            if not text_content and not media_info and not is_self_chat:
                continue
            sender_name = _format_sender(m) if not m.outgoing else None
            entry: dict[str, Any] = {
                "id": m.id,
                "text": text_content,
                "date": int(m.date.timestamp()) if m.date else None,
                "from_user_id": m.from_user.id if m.from_user else None,
                "from_user_name": sender_name,
                "outgoing": m.outgoing,
            }
            entry.update(media_info)
            entry.update(extract_forward_info(m))
            mtid = getattr(m, "message_thread_id", None)
            if mtid is not None:
                entry["message_thread_id"] = int(mtid)
            history.append(entry)
        history.reverse()
        return {"chat_id": chat_id, "messages": history}

    @router.get("/messages/since")
    async def get_messages_since(
        chat_id: int,
        since_id: int,
        limit: int = 50,
        topic_id: Optional[int] = None,
        account: str = "",
    ):
        client = await auth.get_authorized_client(account)
        history: list[dict[str, Any]] = []
        # Pyrogram has no min_id; fetch the freshest page and filter by id
        # client-side. We pull more than `limit` to tolerate filtered-out
        # messages (stickers, service msgs) before slicing.
        fetch_limit = max(int(limit) * 4, 50)
        kwargs: dict[str, Any] = {"limit": fetch_limit}
        if topic_id is not None:
            kwargs["message_thread_id"] = int(topic_id)
        since = int(since_id)
        async for m in client.get_chat_history(chat_id, **kwargs):
            if m.id <= since:
                continue
            text_content = (m.text or m.caption or "").strip()
            media_info = extract_media_info(m, chat_id=chat_id)
            if not text_content and not media_info:
                continue
            sender_name = _format_sender(m) if not m.outgoing else None
            entry: dict[str, Any] = {
                "id": m.id,
                "text": text_content,
                "date": int(m.date.timestamp()) if m.date else None,
                "from_user_id": m.from_user.id if m.from_user else None,
                "from_user_name": sender_name,
                "outgoing": m.outgoing,
            }
            entry.update(media_info)
            entry.update(extract_forward_info(m))
            mtid = getattr(m, "message_thread_id", None)
            if mtid is not None:
                entry["message_thread_id"] = int(mtid)
            history.append(entry)
        history.sort(key=lambda e: e["id"])  # chronological
        return {"chat_id": chat_id, "messages": history[:limit]}

    @router.get("/media/{chat_id}/{message_id}")
    async def get_media(chat_id: int, message_id: int, account: str = ""):
        client = await auth.get_authorized_client(account)
        try:
            msgs = [
                m
                async for m in client.get_chat_history(
                    chat_id, limit=1, offset_id=message_id + 1
                )
            ]
            if not msgs or msgs[0].id != message_id:
                raise HTTPException(status_code=404, detail="Message not found")
            msg = msgs[0]
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))

        try:
            buf = await client.download_media(msg, in_memory=True)
            if buf is None:
                raise HTTPException(status_code=404, detail="Failed to download media")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        buf.seek(0)

        ct = "application/octet-stream"
        if msg.photo:
            ct = "image/jpeg"
        elif msg.video:
            ct = "video/mp4"
        elif msg.video_note:
            ct = "video/mp4"
        elif msg.voice:
            ct = "audio/ogg"
        elif getattr(msg, "audio", None):
            ct = getattr(msg.audio, "mime_type", None) or "audio/mpeg"
        elif msg.document:
            ct = getattr(msg.document, "mime_type", None) or "application/octet-stream"
        return StreamingResponse(buf, media_type=ct)

    @router.post("/send_media")
    async def api_send_media(
        chat_id: int = Form(...),
        media_type: str = Form(...),
        account: str = Form(""),
        caption: str = Form(""),
        message_thread_id: Optional[int] = Form(None),
        file: UploadFile = File(...),
    ):
        client = await auth.get_authorized_client(account)
        if not getattr(client, "me", None):
            try:
                client.me = await client.get_me()
            except Exception:
                logger.warning("get_me() failed in send_media, proceeding without me", exc_info=True)

        suffix = Path(file.filename or "file").suffix
        if not suffix:
            suffix = (
                ".ogg" if media_type == "voice"
                else ".mp4" if media_type == "video_note"
                else ".mp3" if media_type == "audio"
                else ".bin"
            )
        CHUNK_SIZE = 1 << 20  # 1 MiB
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp_path: Optional[str] = None
        try:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                tmp.write(chunk)
            tmp.flush()
            tmp_path = tmp.name
            tmp.close()

            common: dict[str, Any] = {"chat_id": chat_id}
            if message_thread_id is not None:
                common["message_thread_id"] = int(message_thread_id)
            cap = caption or None

            if media_type == "photo":
                sent = await client.send_photo(photo=tmp_path, caption=cap, **common)
            elif media_type == "video":
                sent = await client.send_video(video=tmp_path, caption=cap, **common)
            elif media_type == "video_note":
                # Telegram: video notes don't carry captions.
                sent = await client.send_video_note(video_note=tmp_path, **common)
            elif media_type == "voice":
                sent = await client.send_voice(voice=tmp_path, caption=cap, **common)
            elif media_type == "audio":
                sent = await client.send_audio(audio=tmp_path, caption=cap, **common)
            elif media_type == "document":
                sent = await client.send_document(document=tmp_path, caption=cap, **common)
            else:
                raise HTTPException(status_code=400, detail="Unknown media_type")
            sent_id = sent.id if sent else None
            return {
                "ok": True,
                "message_id": sent_id,
                "media_type": media_type,
                "media_url": f"/media/{chat_id}/{sent_id}" if sent_id else None,
            }
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("send_media failed: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
        finally:
            try:
                if tmp_path:
                    Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                logger.warning("failed to delete tmp file %s", tmp_path, exc_info=True)

    @router.post("/send_message")
    async def api_send_message(payload: dict[str, Any]):
        account = str(payload.get("account", "")).strip()
        chat_id = payload.get("chat_id")
        text = payload.get("text")
        reply_to_message_id = payload.get("reply_to_message_id")
        message_thread_id = payload.get("message_thread_id")
        if chat_id is None or not text:
            raise HTTPException(status_code=400, detail="chat_id and text are required")
        client = manager.get_or_create(account) if account else manager.default
        await manager.ensure_connected(client)
        try:
            kwargs: dict[str, Any] = {"chat_id": chat_id, "text": text}
            if reply_to_message_id is not None:
                kwargs["reply_to_message_id"] = reply_to_message_id
            if message_thread_id is not None:
                kwargs["message_thread_id"] = int(message_thread_id)
            sent = await client.send_message(**kwargs)
            return {"ok": True, "message_id": sent.id}
        except Exception as e:
            logger.warning("send_message to chat %s failed: %s", chat_id, e)
            raise HTTPException(status_code=400, detail=str(e))

    return router
