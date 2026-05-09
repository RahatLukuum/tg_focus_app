"""Dialog list, contacts, chat info, bootstrap, contact resolution."""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Iterable, Optional

from fastapi import APIRouter, HTTPException
from pyrogram import Client

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.folder_service import FolderService
from services.queue_service import QueueService
from services.response_cache import TtlCache

logger = logging.getLogger(__name__)

try:
    from pyrogram.raw.functions.contacts import ImportContacts  # type: ignore
    from pyrogram.raw.types import InputPhoneContact  # type: ignore
except Exception:
    ImportContacts = None  # type: ignore
    InputPhoneContact = None  # type: ignore

try:
    from pyrogram.raw.functions.messages import GetDialogs as RawGetDialogs  # type: ignore
    from pyrogram.raw.types import InputPeerEmpty  # type: ignore
except Exception:
    RawGetDialogs = None  # type: ignore
    InputPeerEmpty = None  # type: ignore


def _map_dialog(d: Any) -> Optional[dict[str, Any]]:
    chat = getattr(d, "chat", None)
    if not chat:
        return None
    try:
        ctype = getattr(chat, "type", None)
        type_name = (
            getattr(ctype, "value", None)
            or (str(ctype).lower() if ctype is not None else "")
        )
    except Exception:
        logger.debug("type detection failed", exc_info=True)
        type_name = ""
    if type_name not in ("private", "group", "supergroup"):
        return None
    last_text = (
        (getattr(d.top_message, "text", None) or getattr(d.top_message, "caption", None) or "").strip()
        if getattr(d, "top_message", None)
        else None
    )
    if last_text == "":
        last_text = None
    title = getattr(chat, "title", None)
    if not title:
        first_name = getattr(chat, "first_name", None) or ""
        last_name = getattr(chat, "last_name", None) or ""
        title = (first_name + (" " + last_name if last_name else "")).strip() or str(chat.id)
    folder_id = int(getattr(d, "folder_id", 0) or 0)
    return {
        "chat_id": chat.id,
        "title": title,
        "type": type_name,
        "username": getattr(chat, "username", None),
        "unread_count": getattr(d, "unread_messages_count", 0),
        "last_message_text": last_text,
        "folder_id": folder_id,
        "is_forum": bool(getattr(chat, "is_forum", False)),
    }


def _build_queue_from_dialogs(dialogs: Iterable[Any]) -> list[int]:
    """Return chat_ids that should be in the queue.

    Includes private + group + supergroup with unread > 0, excludes archive
    (folder_id == 1). Preserves first-seen order; dedupes.
    """
    queue: list[int] = []
    seen: set[int] = set()
    for d in dialogs:
        item = _map_dialog(d)
        if not item:
            continue
        if item.get("folder_id") == 1:
            continue
        if int(item.get("unread_count", 0) or 0) <= 0:
            continue
        cid = int(item["chat_id"])
        if cid in seen:
            continue
        seen.add(cid)
        queue.append(cid)
    return queue


async def _fetch_archived_chat_ids(client: Client, limit: int = 200) -> set[int]:
    """Return the set of chat_ids in folder_id=1 (Archive).

    Pyrogram's high-level ``get_dialogs`` only walks the main folder, so
    archived chats are invisible to it. We use raw ``messages.GetDialogs``
    with ``folder_id=1`` and translate raw peers into the same chat_id
    convention the rest of the codebase uses.
    """
    if RawGetDialogs is None or InputPeerEmpty is None:
        return set()
    archived_chat_ids: set[int] = set()
    try:
        result = await client.invoke(
            RawGetDialogs(
                offset_date=0,
                offset_id=0,
                offset_peer=InputPeerEmpty(),
                limit=limit,
                hash=0,
                folder_id=1,
            )
        )
    except Exception:
        logger.debug("raw archived GetDialogs failed", exc_info=True)
        return archived_chat_ids
    for d in getattr(result, "dialogs", []) or []:
        peer = getattr(d, "peer", None)
        if peer is None:
            continue
        if hasattr(peer, "channel_id"):
            archived_chat_ids.add(int(f"-100{int(peer.channel_id)}"))
        elif hasattr(peer, "chat_id"):
            archived_chat_ids.add(-int(peer.chat_id))
        elif hasattr(peer, "user_id"):
            archived_chat_ids.add(int(peer.user_id))
    return archived_chat_ids


async def _build_dialogs_and_queue(client: Client, limit: int = 100) -> dict[str, Any]:
    dialogs_raw: list[Any] = []
    async for d in client.get_dialogs(limit=limit):
        dialogs_raw.append(d)

    # Fetch archived chats in parallel — Pyrogram's high-level get_dialogs
    # only walks the main folder, so archives are otherwise invisible.
    archived_task = asyncio.create_task(_fetch_archived_chat_ids(client, limit=max(limit, 200)))

    dialogs: list[dict[str, Any]] = []
    archived_ids: set[int] = set()
    for d in dialogs_raw:
        item = _map_dialog(d)
        if not item:
            continue
        dialogs.append(item)
        if item.get("folder_id") == 1:
            archived_ids.add(int(item["chat_id"]))

    # Merge raw archived ids (catches archives that Pyrogram's main-folder
    # get_dialogs() never returned).
    archived_from_raw = await archived_task
    archived_ids |= archived_from_raw

    # Saved Messages fallback: ensure self-chat is always discoverable.
    try:
        me = await client.get_me()
        me_id = int(getattr(me, "id", 0) or 0)
    except Exception:
        logger.debug("get_me() failed in dialogs build", exc_info=True)
        me_id = 0
    if me_id and not any(d["chat_id"] == me_id for d in dialogs):
        try:
            saved = await client.get_chat(me_id)
            dialogs.append({
                "chat_id": me_id,
                "title": getattr(saved, "title", None) or "Saved Messages",
                "type": "private",
                "username": getattr(saved, "username", None),
                "unread_count": 0,
                "last_message_text": None,
                "folder_id": 0,
                "is_forum": False,
                "is_saved_messages": True,
            })
        except Exception:
            logger.debug("Saved Messages fallback fetch failed", exc_info=True)
    else:
        # Mark the existing self-chat row.
        for d in dialogs:
            if d["chat_id"] == me_id:
                d["is_saved_messages"] = True
                if not d.get("title"):
                    d["title"] = "Saved Messages"

    queue_ids = _build_queue_from_dialogs(dialogs_raw)
    return {"dialogs": dialogs, "queue": queue_ids, "archived_ids": archived_ids}


def _normalize_phone_e164(phone: str) -> str:
    digits = re.sub(r"\D+", "", phone or "")
    if not digits:
        return phone
    if len(digits) == 11 and (digits.startswith("8") or digits.startswith("7")):
        return "+7" + digits[1:]
    if len(digits) == 10:
        return "+7" + digits
    if digits.startswith("7"):
        return "+" + digits
    return phone if phone.startswith("+") else ("+" + digits)


async def _resolve_user_by_phone(client: Client, phone: str) -> Optional[int]:
    if ImportContacts is None or InputPhoneContact is None:
        return None
    try:
        normalized = _normalize_phone_e164(phone)
        result = await client.invoke(
            ImportContacts(
                contacts=[
                    InputPhoneContact(
                        client_id=0, phone=normalized, first_name=".", last_name=""
                    )
                ]
            )
        )
        users = getattr(result, "users", []) or []
        for u in users:
            uid = getattr(u, "id", None)
            if uid:
                return int(uid)
    except Exception:
        logger.warning("ImportContacts failed for phone %s", phone, exc_info=True)
        return None
    return None


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
    folder_service: FolderService,
) -> APIRouter:
    router = APIRouter()

    bootstrap_cache: TtlCache[str, dict[str, Any]] = TtlCache(ttl_seconds=30)

    async def _get_contacts_payload(account: str) -> list[dict[str, Any]]:
        client = manager.get_or_create(account) if account else manager.default
        await manager.ensure_connected(client)
        try:
            await client.get_me()
        except Exception:
            raise HTTPException(status_code=401, detail="Not authorized")
        out: list[dict[str, Any]] = []
        try:
            users = await client.get_contacts()
            for u in users:
                first = getattr(u, "first_name", None) or ""
                last = getattr(u, "last_name", None) or ""
                title = (first + (" " + last if last else "")).strip() or str(u.id)
                out.append(
                    {
                        "chat_id": u.id,
                        "title": title,
                        "type": "private",
                        "username": getattr(u, "username", None),
                        "phone": getattr(u, "phone_number", None),
                    }
                )
        except Exception:
            logger.warning("get_contacts() failed, returning empty contacts", exc_info=True)
        return out

    async def _attach_folder_ids(
        items: list[dict[str, Any]], account: str
    ) -> None:
        """Decorate each dialog with folder_ids from FolderService cache."""
        try:
            payload = await folder_service.get_folders(account=account)
        except Exception:
            logger.warning("FolderService.get_folders failed", exc_info=True)
            payload = {"chat_to_folders": {}}
        c2f = payload.get("chat_to_folders", {})
        for item in items:
            cid = int(item["chat_id"])
            item["folder_ids"] = list(c2f.get(cid, []))

    @router.get("/contacts")
    async def get_contacts(account: str = ""):
        return {"contacts": await _get_contacts_payload(account)}

    @router.get("/dialogs")
    async def get_dialogs(limit: int = 100, account: str = ""):
        client = await auth.get_authorized_client(account)
        payload = await _build_dialogs_and_queue(client, limit=limit)
        await _attach_folder_ids(payload["dialogs"], account)
        return {"dialogs": payload["dialogs"]}

    @router.get("/bootstrap")
    async def get_bootstrap(limit: int = 100, account: str = ""):
        cache_key = f"{account}|{limit}"

        async def _load() -> dict[str, Any]:
            client = await auth.get_authorized_client(account)
            dialogs_task = asyncio.create_task(_build_dialogs_and_queue(client, limit=limit))
            contacts_task = asyncio.create_task(_get_contacts_payload(account))
            dialogs_payload, contacts_payload = await asyncio.gather(dialogs_task, contacts_task)
            archived_ids = dialogs_payload["archived_ids"]
            # Tell FolderService which chats are archived (handler uses this).
            folder_service.set_archived(account, archived_ids)
            await _attach_folder_ids(dialogs_payload["dialogs"], account)
            queue_ids = dialogs_payload["queue"]
            await queue_service.replace(account, queue_ids)

            # Prune any persisted queue entries that turned out to be archived.
            # _build_queue_from_dialogs already excludes folder_id==1 entries
            # we saw, but raw GetDialogs(folder_id=1) catches archives that
            # never showed up in the main folder dump.
            try:
                order = await queue_service.get(account)
                for cid in [c for c in order if int(c) in archived_ids]:
                    await queue_service.remove(account, cid)
            except Exception:
                logger.debug("queue prune against archived_ids failed", exc_info=True)

            return {
                "dialogs": dialogs_payload["dialogs"],
                "contacts": contacts_payload,
                "queue": queue_ids,
            }

        return await bootstrap_cache.get_or_load(cache_key, _load)

    @router.get("/chat_info")
    async def chat_info(chat_id: int, account: str = ""):
        client = await auth.get_authorized_client(account)
        try:
            ch = await client.get_chat(chat_id)
        except Exception as e:
            logger.warning("get_chat(%s) failed: %s", chat_id, e)
            raise HTTPException(status_code=404, detail=str(e))
        try:
            ctype = getattr(ch, "type", None)
            type_name = (
                getattr(ctype, "value", None)
                or (str(ctype).lower() if ctype is not None else "")
            )
        except Exception:
            logger.debug("type detection failed in chat_info, falling through", exc_info=True)
            type_name = ""
        title = getattr(ch, "title", None)
        if not title:
            first_name = getattr(ch, "first_name", None) or ""
            last_name = getattr(ch, "last_name", None) or ""
            title = (first_name + (" " + last_name if last_name else "")).strip() or str(chat_id)
        return {
            "chat": {
                "chat_id": int(getattr(ch, "id", chat_id)),
                "title": title,
                "type": type_name,
                "username": getattr(ch, "username", None),
            }
        }

    @router.post("/resolve_contact")
    async def resolve_contact(payload: dict[str, Any]):
        account = str(payload.get("account", "")).strip()
        client = manager.get_or_create(account) if account else manager.default
        await manager.ensure_connected(client)

        user_id = payload.get("user_id")
        phone = payload.get("phone")
        username = payload.get("username")
        if not user_id and not phone and not username:
            raise HTTPException(status_code=400, detail="user_id or phone or username is required")

        if user_id:
            try:
                uid = int(user_id)
            except Exception:
                raise HTTPException(status_code=400, detail="invalid user_id")
            return {"ok": True, "user_id": uid, "chat_id": uid}

        if phone:
            raw_phone = str(phone).strip()
            uid = await _resolve_user_by_phone(client, raw_phone)
            if uid:
                return {"ok": True, "user_id": uid, "chat_id": uid}
            digits_only = re.sub(r"\D+", "", raw_phone)
            if digits_only:
                try:
                    fallback_uid = int(digits_only)
                except (ValueError, OverflowError):
                    fallback_uid = None
                if fallback_uid is not None:
                    return {"ok": True, "user_id": fallback_uid, "chat_id": fallback_uid}
            raise HTTPException(status_code=404, detail="User not found by phone")

        if username:
            uname = str(username).strip()
            if uname.startswith("@"):
                uname = uname[1:]
            try:
                ch = await client.get_chat(uname)
                try:
                    ctype = getattr(ch, "type", None)
                    type_name = (
                        getattr(ctype, "value", None)
                        or (str(ctype).lower() if ctype is not None else "")
                    )
                except Exception:
                    logger.debug("type detection failed in resolve_contact, falling through", exc_info=True)
                    type_name = ""
                if type_name and type_name != "private":
                    raise HTTPException(status_code=400, detail="Username is not a private user")
                uid = getattr(ch, "id", None)
                if not uid:
                    raise HTTPException(status_code=404, detail="User not found by username")
                return {"ok": True, "user_id": int(uid), "chat_id": int(uid)}
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(status_code=404, detail="User not found by username")

        raise HTTPException(status_code=400, detail="invalid payload")

    return router
