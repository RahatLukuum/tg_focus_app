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


async def _build_dialogs_and_queue(client: Client, limit: int = 100) -> dict[str, Any]:
    dialogs_raw: list[Any] = []
    async for d in client.get_dialogs(limit=limit):
        dialogs_raw.append(d)

    dialogs: list[dict[str, Any]] = []
    archived_ids: set[int] = set()
    for d in dialogs_raw:
        item = _map_dialog(d)
        if not item:
            continue
        dialogs.append(item)
        if item.get("folder_id") == 1:
            archived_ids.add(int(item["chat_id"]))
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
            # Tell FolderService which chats are archived (handler uses this).
            folder_service.set_archived(account, dialogs_payload["archived_ids"])
            await _attach_folder_ids(dialogs_payload["dialogs"], account)
            queue_ids = dialogs_payload["queue"]
            await queue_service.replace(account, queue_ids)
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
