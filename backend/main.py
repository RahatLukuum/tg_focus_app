from pyrogram import Client, filters
from pyrogram.handlers import MessageHandler
from pyrogram.types import Message
from pyrogram.errors import SessionPasswordNeeded, PasswordHashInvalid
from decouple import config

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import tempfile
import io

import asyncio
from pathlib import Path
import re

try:
    # Optional raw imports for resolving phone -> user
    from pyrogram.raw.functions.contacts import ImportContacts  # type: ignore
    from pyrogram.raw.types import InputPhoneContact  # type: ignore
except Exception:
    ImportContacts = None  # type: ignore
    InputPhoneContact = None  # type: ignore
from typing import Dict, Set, List, Any


# Данные приложения/аккаунта
api_id = int(config("API_ID"))
api_hash = config("API_HASH")
login = config("LOGIN")  # имя файла сессии

# Директория для хранения .session (persist между перезапусками)
session_dir = config("SESSION_DIR", default=str((Path(__file__).parent / "sessions").resolve()))
try:
    Path(session_dir).mkdir(parents=True, exist_ok=True)
except Exception:
    pass


# Инициализация Pyrogram-клиента (без автологина)
# Опциональный прокси (на случай блокировок Telegram в сети)
proxy = None
try:
    proxy_host = config("PROXY_HOST", default=None)
    proxy_port = config("PROXY_PORT", default=None)
    if proxy_host and proxy_port:
        proxy = {
            "scheme": config("PROXY_SCHEME", default="socks5"),
            "hostname": proxy_host,
            "port": int(proxy_port),
        }
        proxy_user = config("PROXY_USERNAME", default=None)
        proxy_pass = config("PROXY_PASSWORD", default=None)
        if proxy_user:
            proxy["username"] = proxy_user
        if proxy_pass:
            proxy["password"] = proxy_pass
except Exception:
    proxy = None

bot = Client(name=login, api_id=api_id, api_hash=api_hash, proxy=proxy, workdir=session_dir)


# Глобальные состояния
pending_logins: Dict[str, str] = {}
connected_clients: Set[WebSocket] = set()

# Очередь диалогов для страницы "разбор очереди"
try:
    # Python 3.10+ syntax is not supported on 3.8; annotate in a compatible way
    from typing import Optional
    queue_chat_ids: Optional[asyncio.Queue] = None  # type: ignore[assignment]
except Exception:
    queue_chat_ids = None  # type: ignore[assignment]
queued_chat_order: List[int] = []
queued_chat_set: Set[int] = set()

# Пер-аккаунт очереди (для мульти-аккаунт режима)
queued_chat_order_by_account: Dict[str, List[int]] = {}
queued_chat_set_by_account: Dict[str, Set[int]] = {}
queue_lock = asyncio.Lock()


def ensure_in_queue(chat_id: int) -> None:
    if chat_id not in queued_chat_set:
        queued_chat_set.add(chat_id)
        queued_chat_order.append(chat_id)


def remove_from_queue(chat_id: int) -> None:
    if chat_id in queued_chat_set:
        queued_chat_set.remove(chat_id)
        try:
            queued_chat_order.remove(chat_id)
        except ValueError:
            pass


def move_to_queue_end(chat_id: int) -> None:
    if chat_id in queued_chat_set:
        try:
            queued_chat_order.remove(chat_id)
        except ValueError:
            pass
        queued_chat_order.append(chat_id)
    else:
        ensure_in_queue(chat_id)

# Пер-аккаунт операции с очередью
def ensure_in_queue_for_account(account: str, chat_id: int) -> None:
    if account not in queued_chat_set_by_account:
        queued_chat_set_by_account[account] = set()
    if account not in queued_chat_order_by_account:
        queued_chat_order_by_account[account] = []
    if chat_id not in queued_chat_set_by_account[account]:
        queued_chat_set_by_account[account].add(chat_id)
        queued_chat_order_by_account[account].append(chat_id)


def remove_from_queue_for_account(account: str, chat_id: int) -> None:
    if account not in queued_chat_set_by_account or account not in queued_chat_order_by_account:
        return
    if chat_id in queued_chat_set_by_account[account]:
        queued_chat_set_by_account[account].remove(chat_id)
        try:
            queued_chat_order_by_account[account].remove(chat_id)
        except ValueError:
            pass


def move_to_queue_end_for_account(account: str, chat_id: int) -> None:
    if account not in queued_chat_set_by_account:
        queued_chat_set_by_account[account] = set()
    if account not in queued_chat_order_by_account:
        queued_chat_order_by_account[account] = []
    if chat_id in queued_chat_set_by_account[account]:
        try:
            queued_chat_order_by_account[account].remove(chat_id)
        except ValueError:
            pass
        queued_chat_order_by_account[account].append(chat_id)
    else:
        ensure_in_queue_for_account(account, chat_id)


async def broadcast(event: Dict[str, Any]) -> None:
    stale: List[WebSocket] = []
    for ws in connected_clients:
        try:
            await ws.send_json(event)
        except Exception:
            stale.append(ws)
    for ws in stale:
        try:
            connected_clients.remove(ws)
        except KeyError:
            pass


def _extract_media_info(message: Message) -> Dict[str, Any]:
    media_type = None
    file_name = None
    duration = None
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
    result: Dict[str, Any] = {}
    if media_type:
        result["media_type"] = media_type
        result["media_url"] = f"/media/{message.chat.id}/{message.id}"
        if file_name:
            result["file_name"] = file_name
        if duration is not None:
            result["duration"] = duration
    return result


@bot.on_message(filters.incoming & ~filters.service)
async def incoming_handler(client: Client, message: Message):
    chat_id = message.chat.id
    try:
        ctype = getattr(message.chat, "type", None)
        type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
    except Exception:
        type_name = ""
    if type_name != "private":
        return

    ensure_in_queue(chat_id)
    await broadcast({"type": "queue_update", "account": "", "chat_id": chat_id})

    preview_text = (message.text or message.caption or "").strip()
    media_info = _extract_media_info(message)
    author = None
    try:
        if message.from_user:
            author = (message.from_user.first_name or "") + (" " + message.from_user.last_name if message.from_user.last_name else "")
        elif message.sender_chat:
            author = message.sender_chat.title
    except Exception:
        author = None

    if preview_text or media_info:
        msg_payload: Dict[str, Any] = {
            "id": message.id,
            "text": preview_text,
            "date": int(message.date.timestamp()) if message.date else None,
            "from_user_id": message.from_user.id if message.from_user else None,
            "from_user_name": author,
            "outgoing": message.outgoing,
        }
        msg_payload.update(media_info)
        await broadcast(
            {
                "type": "message",
                "account": "",
                "chat_id": chat_id,
                "chat_title": message.chat.title if getattr(message.chat, "title", None) else author or "",
                "message": msg_payload,
            }
        )


app = FastAPI(title="TG Backend API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "service": "TG Backend API",
        "status": "ok",
        "docs": "/docs",
        "endpoints": [
            "/auth/send_code",
            "/auth/sign_in",
            "/me",
            "/dialogs",
            "/messages",
            "/send_message",
            "/queue",
            "/queue/action",
            "/ws",
        ],
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


async def ensure_connected() -> None:
    try:
        if not bot.is_connected:
            await bot.connect()
    except Exception:
        await bot.connect()


async def ensure_started() -> None:
    # Подключаемся без инициирования интерактивного старта.
    # Если сессия уже сохранена, get_me сработает; если нет — просто вернёмся без авторизации.
    try:
        if not bot.is_connected:
            await bot.connect()
    except Exception:
        pass


# ==== МУЛЬТИ-АККАУНТ КЛИЕНТЫ ====
clients: Dict[str, Client] = {}


def attach_incoming_handler(client: Client, account: str) -> None:
    async def _handler(c: Client, message: Message) -> None:
        # filter: only private chats
        try:
            ctype = getattr(message.chat, "type", None)
            type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
        except Exception:
            type_name = ""
        if type_name != "private":
            return

        ensure_in_queue_for_account(account, message.chat.id)
        await broadcast({"type": "queue_update", "account": account, "chat_id": message.chat.id})

        preview_text = (message.text or message.caption or "").strip()
        media_info = _extract_media_info(message)
        author = None
        try:
            if message.from_user:
                author = (message.from_user.first_name or "") + (" " + message.from_user.last_name if message.from_user.last_name else "")
            elif message.sender_chat:
                author = message.sender_chat.title
        except Exception:
            author = None

        if preview_text or media_info:
            msg_payload: Dict[str, Any] = {
                "id": message.id,
                "text": preview_text,
                "date": int(message.date.timestamp()) if message.date else None,
                "from_user_id": message.from_user.id if message.from_user else None,
                "from_user_name": author,
                "outgoing": message.outgoing,
            }
            msg_payload.update(media_info)
            await broadcast(
                {
                    "type": "message",
                    "account": account,
                    "chat_id": message.chat.id,
                    "chat_title": message.chat.title if getattr(message.chat, "title", None) else author or "",
                    "message": msg_payload,
                }
            )

    client.add_handler(MessageHandler(_handler, filters.incoming & ~filters.service))


def get_or_create_client(account: str) -> Client:
    account_key = account.strip()
    if account_key in clients:
        return clients[account_key]
    c = Client(
        name=account_key,
        api_id=api_id,
        api_hash=api_hash,
        proxy=proxy,
        workdir=session_dir,
    )
    attach_incoming_handler(c, account_key)
    clients[account_key] = c
    return c


async def ensure_client_connected(client: Client) -> None:
    try:
        if not client.is_connected:
            await client.connect()
    except Exception:
        await client.connect()


async def get_authorized_client(account: str = "") -> Client:
    client: Client
    if account:
        client = get_or_create_client(account)
        await ensure_client_connected(client)
    else:
        await ensure_started()
        client = bot
    try:
        await client.get_me()
    except Exception:
        raise HTTPException(status_code=401, detail="Not authorized")
    return client


def map_dialog_to_payload(d: Any) -> Optional[Dict[str, Any]]:
    chat = getattr(d, "chat", None)
    if not chat:
        return None
    try:
        ctype = getattr(chat, "type", None)
        type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
    except Exception:
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
    return {
        "chat_id": chat.id,
        "title": title,
        "type": type_name,
        "username": getattr(chat, "username", None),
        "unread_count": getattr(d, "unread_messages_count", 0),
        "last_message_text": last_text,
    }


async def build_dialogs_and_queue(client: Client, limit: int = 100) -> Dict[str, Any]:
    dialogs: List[Dict[str, Any]] = []
    queue_ids: List[int] = []
    queue_seen: Set[int] = set()
    async for d in client.get_dialogs(limit=limit):
        item = map_dialog_to_payload(d)
        if not item:
            continue
        dialogs.append(item)
        if item["type"] == "private" and int(item.get("unread_count", 0) or 0) > 0:
            cid = int(item["chat_id"])
            if cid not in queue_seen:
                queue_seen.add(cid)
                queue_ids.append(cid)
    return {"dialogs": dialogs, "queue": queue_ids}


@app.on_event("shutdown")
async def on_shutdown():
    try:
        await bot.stop()
    except Exception:
        pass
    # Останавливаем мульти-клиентов
    for c in list(clients.values()):
        try:
            await c.stop()
        except Exception:
            pass


# ==== АВТОРИЗАЦИЯ ====

@app.api_route("/auth/send_code", methods=["POST", "OPTIONS"])  # поддержка и без/с preflight
@app.api_route("/auth/send_code/", methods=["POST", "OPTIONS"])  # на случай завершающего слэша
async def auth_send_code(payload: Dict[str, str]):
    phone = payload.get("phone")
    if not phone:
        raise HTTPException(status_code=400, detail="phone is required")

    client = get_or_create_client(phone)
    await ensure_client_connected(client)
    try:
        sent = await client.send_code(phone)
        # Сохраняем хеш кода для последующего sign_in
        phone_code_hash = getattr(sent, "phone_code_hash", None) or getattr(sent, "phone_code", None)
        if not phone_code_hash:
            # Нестандартный случай, но вернем ok без хеша
            pending_logins[phone] = ""
            return {"ok": True}
        pending_logins[phone] = phone_code_hash
        return {"ok": True, "phone_code_hash": phone_code_hash}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.api_route("/auth/sign_in", methods=["POST", "OPTIONS"])  # поддержка и без/с preflight
@app.api_route("/auth/sign_in/", methods=["POST", "OPTIONS"])  # на случай завершающего слэша
async def auth_sign_in(payload: Dict[str, str]):
    phone = payload.get("phone")
    code = payload.get("code")
    password = payload.get("password")

    if not phone or not code:
        raise HTTPException(status_code=400, detail="phone and code are required")

    phone_code_hash = pending_logins.get(phone)
    if not phone_code_hash:
        raise HTTPException(status_code=400, detail="send_code must be called first")

    client = get_or_create_client(phone)
    await ensure_client_connected(client)

    # 2FA: после sign_in Pyrogram ждёт check_password. Повторный sign_in с тем же кодом ломает вход.
    if password:
        try:
            await client.check_password(password=password)
        except PasswordHashInvalid:
            raise HTTPException(
                status_code=400,
                detail="Неверный пароль двухфакторной аутентификации",
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    else:
        try:
            await client.sign_in(
                phone_number=phone,
                phone_code=code,
                phone_code_hash=phone_code_hash,
            )
        except SessionPasswordNeeded:
            raise HTTPException(status_code=401, detail="Two-factor password required")
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    try:
        me = await client.get_me()
    except Exception:
        me = None

    return {"ok": True, "me": {"id": me.id, "first_name": me.first_name, "username": me.username} if me else None}


@app.get("/me")
async def get_me(account: str = ""):
    try:
        if account:
            client = get_or_create_client(account)
            await ensure_client_connected(client)
            me = await client.get_me()
        else:
            await ensure_started()
            me = await bot.get_me()
        return {"authorized": True, "me": {"id": me.id, "first_name": me.first_name, "username": me.username}}
    except Exception:
        return {"authorized": False}


# ==== ДИАЛОГИ и ИСТОРИЯ ====

@app.get("/contacts")
async def get_contacts(account: str = ""):
    client_obj: Client
    if account:
        client_obj = get_or_create_client(account)
        await ensure_client_connected(client_obj)
    else:
        await ensure_started()
        client_obj = bot
    try:
        await client_obj.get_me()
    except Exception:
        raise HTTPException(status_code=401, detail="Not authorized")
    contacts_list: List[Dict[str, Any]] = []
    try:
        users = await client_obj.get_contacts()
        for u in users:
            first = getattr(u, "first_name", None) or ""
            last = getattr(u, "last_name", None) or ""
            title = (first + (" " + last if last else "")).strip() or str(u.id)
            contacts_list.append({
                "chat_id": u.id,
                "title": title,
                "type": "private",
                "username": getattr(u, "username", None),
                "phone": getattr(u, "phone_number", None),
            })
    except Exception:
        pass
    return {"contacts": contacts_list}


@app.get("/dialogs")
async def get_dialogs(limit: int = 100, account: str = ""):
    client = await get_authorized_client(account)
    payload = await build_dialogs_and_queue(client, limit=limit)
    return {"dialogs": payload["dialogs"]}


@app.get("/bootstrap")
async def get_bootstrap(limit: int = 100, account: str = ""):
    client = await get_authorized_client(account)
    dialogs_task = asyncio.create_task(build_dialogs_and_queue(client, limit=limit))
    contacts_task = asyncio.create_task(get_contacts(account))
    dialogs_payload, contacts_payload = await asyncio.gather(dialogs_task, contacts_task)
    queue_ids = dialogs_payload["queue"]
    if account:
        async with queue_lock:
            queued_chat_order_by_account[account] = list(queue_ids)
            queued_chat_set_by_account[account] = set(queue_ids)
    else:
        queued_chat_order.clear()
        queued_chat_set.clear()
        for cid in queue_ids:
            ensure_in_queue(cid)
    return {
        "dialogs": dialogs_payload["dialogs"],
        "contacts": contacts_payload.get("contacts", []),
        "queue": queue_ids,
    }


@app.get("/messages")
async def get_messages(chat_id: int, limit: int = 50, before_id: Optional[int] = None, account: str = ""):
    client: Client
    if account:
        client = get_or_create_client(account)
        await ensure_client_connected(client)
    else:
        await ensure_started()
        client = bot
    try:
        await client.get_me()
    except Exception:
        raise HTTPException(status_code=401, detail="Not authorized")
    history = []
    kwargs: Dict[str, Any] = {"limit": limit}
    if before_id:
        try:
            kwargs["max_id"] = int(before_id) - 1
        except Exception:
            pass
    async for m in client.get_chat_history(chat_id, **kwargs):
        text_content = (m.text or m.caption or "").strip()
        media_type = None
        file_name = None
        duration = None
        if m.photo:
            media_type = "photo"
        elif m.video:
            media_type = "video"
            duration = getattr(m.video, "duration", None)
            file_name = getattr(m.video, "file_name", None)
        elif m.voice:
            media_type = "voice"
            duration = getattr(m.voice, "duration", None)
        elif m.video_note:
            media_type = "video"
            duration = getattr(m.video_note, "duration", None)
        elif m.document:
            media_type = "document"
            file_name = getattr(m.document, "file_name", None)
        if not text_content and not media_type:
            continue
        sender_name = None
        if not m.outgoing:
            if m.from_user:
                first = getattr(m.from_user, "first_name", None) or ""
                last = getattr(m.from_user, "last_name", None) or ""
                sender_name = (first + (" " + last if last else "")).strip() or None
            elif getattr(m, "sender_chat", None):
                sender_name = getattr(m.sender_chat, "title", None)
        entry: Dict[str, Any] = {
            "id": m.id,
            "text": text_content,
            "date": int(m.date.timestamp()) if m.date else None,
            "from_user_id": m.from_user.id if m.from_user else None,
            "from_user_name": sender_name,
            "outgoing": m.outgoing,
        }
        if media_type:
            entry["media_type"] = media_type
            entry["media_url"] = f"/media/{chat_id}/{m.id}"
            if file_name:
                entry["file_name"] = file_name
            if duration is not None:
                entry["duration"] = duration
        history.append(entry)
    history.reverse()
    return {"chat_id": chat_id, "messages": history}


@app.get("/chat_info")
async def chat_info(chat_id: int, account: str = ""):
    client: Client
    if account:
        client = get_or_create_client(account)
        await ensure_client_connected(client)
    else:
        await ensure_started()
        client = bot
    try:
        await client.get_me()
    except Exception:
        raise HTTPException(status_code=401, detail="Not authorized")
    try:
        ch = await client.get_chat(chat_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        ctype = getattr(ch, "type", None)
        type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
    except Exception:
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
            "type": type_name or (ch.type.value if hasattr(ch, "type") and hasattr(ch.type, "value") else str(getattr(ch, "type", ""))),
            "username": getattr(ch, "username", None),
        }
    }



# ==== МЕДИА ====

@app.get("/media/{chat_id}/{message_id}")
async def get_media(chat_id: int, message_id: int, account: str = ""):
    client_obj: Client
    if account:
        client_obj = get_or_create_client(account)
        await ensure_client_connected(client_obj)
    else:
        await ensure_started()
        client_obj = bot
    try:
        msgs = [m async for m in client_obj.get_chat_history(chat_id, limit=1, offset_id=message_id + 1)]
        if not msgs:
            raise HTTPException(status_code=404, detail="Message not found")
        msg = msgs[0]
        if msg.id != message_id:
            raise HTTPException(status_code=404, detail="Message not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        buf = await client_obj.download_media(msg, in_memory=True)
        if buf is None:
            raise HTTPException(status_code=404, detail="Failed to download media")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    buf.seek(0)

    ct = "application/octet-stream"
    if msg.photo:
        ct = "image/jpeg"
    elif msg.video or msg.video_note:
        ct = "video/mp4"
    elif msg.voice:
        ct = "audio/ogg"
    elif msg.document:
        mime = getattr(msg.document, "mime_type", None)
        if mime:
            ct = mime
    return StreamingResponse(buf, media_type=ct)


@app.post("/send_media")
async def api_send_media(
    chat_id: int = Form(...),
    media_type: str = Form(...),
    account: str = Form(""),
    caption: str = Form(""),
    file: UploadFile = File(...),
):
    client_obj: Client
    if account:
        client_obj = get_or_create_client(account)
        await ensure_client_connected(client_obj)
    else:
        await ensure_started()
        client_obj = bot

    if not getattr(client_obj, "me", None):
        try:
            client_obj.me = await client_obj.get_me()
        except Exception:
            pass

    tmp_path: Optional[str] = None
    suffix = Path(file.filename or "file").suffix
    if not suffix:
        suffix = ".ogg" if media_type == "voice" else ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp_path = tmp.name
        tmp.close()

        sent = None
        if media_type == "photo":
            sent = await client_obj.send_photo(chat_id=chat_id, photo=tmp_path, caption=caption or None)
        elif media_type == "video":
            sent = await client_obj.send_video(chat_id=chat_id, video=tmp_path, caption=caption or None)
        elif media_type == "voice":
            sent = await client_obj.send_voice(chat_id=chat_id, voice=tmp_path, caption=caption or None)
        elif media_type == "document":
            sent = await client_obj.send_document(chat_id=chat_id, document=tmp_path, caption=caption or None)
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
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass


# ==== ОТПРАВКА СООБЩЕНИЙ ====

@app.post("/send_message")
async def api_send_message(payload: Dict[str, Any]):
    account = str(payload.get("account", "")).strip()
    chat_id = payload.get("chat_id")
    text = payload.get("text")
    reply_to_message_id = payload.get("reply_to_message_id")
    if chat_id is None or not text:
        raise HTTPException(status_code=400, detail="chat_id and text are required")

    if account:
        client = get_or_create_client(account)
        await ensure_client_connected(client)
    else:
        await ensure_started()
        client = bot
    try:
        sent = await client.send_message(chat_id=chat_id, text=text, reply_to_message_id=reply_to_message_id)
        return {"ok": True, "message_id": sent.id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ==== REAL-TIME WS ====

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    try:
        while True:
            # Держим соединение открытым; сообщения от клиента игнорируем
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        try:
            connected_clients.remove(ws)
        except KeyError:
            pass


# ==== ОЧЕРЕДЬ ДИАЛОГОВ ====

@app.get("/queue")
async def get_queue(account: str = ""):
    if account:
        if account not in queued_chat_order_by_account:
            try:
                client = await get_authorized_client(account)
                payload = await build_dialogs_and_queue(client, limit=100)
                async with queue_lock:
                    queued_chat_order_by_account[account] = list(payload["queue"])
                    queued_chat_set_by_account[account] = set(payload["queue"])
            except Exception:
                pass
        order = queued_chat_order_by_account.get(account, [])
        return {"queue": order}
    else:
        if not queued_chat_order:
            try:
                client = await get_authorized_client("")
                payload = await build_dialogs_and_queue(client, limit=100)
                queued_chat_order.clear()
                queued_chat_set.clear()
                for cid in payload["queue"]:
                    ensure_in_queue(cid)
            except Exception:
                pass
        return {"queue": queued_chat_order}


# ==== SPA (Frontend) STATIC SERVE ====
# Serve the entire built frontend from /app with HTML fallback for client-side routing
try:
    DIST_DIR = (Path(__file__).parent / "frontend" / "dist").resolve()
    if DIST_DIR.exists():
        app.mount("/app", StaticFiles(directory=str(DIST_DIR), html=True), name="app")
except Exception:
    pass


@app.post("/queue/action")
async def queue_action(payload: Dict[str, Any]):
    chat_id = payload.get("chat_id")
    action = str(payload.get("action", "")).lower()
    if chat_id is None or action not in {"done", "postpone", "task"}:
        raise HTTPException(status_code=400, detail="chat_id and valid action are required")

    account = str(payload.get("account", "")).strip()
    if account:
        if action == "done":
            try:
                client = get_or_create_client(account)
                await ensure_client_connected(client)
                await client.read_chat_history(chat_id)
            except Exception:
                pass
            async with queue_lock:
                remove_from_queue_for_account(account, chat_id)
        elif action in {"postpone", "task"}:
            async with queue_lock:
                move_to_queue_end_for_account(account, chat_id)

        order = queued_chat_order_by_account.get(account, [])
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}
    else:
        if action == "done":
            # помечаем диалог как прочитанный, чтобы не всплывал снова из-за старых непрочитанных
            try:
                await ensure_started()
                await bot.read_chat_history(chat_id)
            except Exception:
                pass
            remove_from_queue(chat_id)
        elif action in {"postpone", "task"}:
            move_to_queue_end(chat_id)

        next_chat_id = queued_chat_order[0] if queued_chat_order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": queued_chat_order}


# ==== RESOLVE CONTACT BY PHONE/USER_ID/USERNAME ====

def _normalize_phone_e164(phone: str) -> str:
    digits = re.sub(r"\D+", "", phone or "")
    if not digits:
        return phone
    # heuristic for RU: 11 digits starting with 8/7 -> +7..........
    if len(digits) == 11 and (digits.startswith("8") or digits.startswith("7")):
        return "+7" + digits[1:]
    if len(digits) == 10:
        return "+7" + digits
    if digits.startswith("7"):
        return "+" + digits
    return phone if phone.startswith("+") else ("+" + digits)


async def _resolve_user_by_phone_client(client: Client, phone: str) -> Optional[int]:
    if ImportContacts is None or InputPhoneContact is None:
        return None
    try:
        normalized = _normalize_phone_e164(phone)
        result = await client.invoke(
            ImportContacts(
                contacts=[
                    InputPhoneContact(client_id=0, phone=normalized, first_name=".", last_name="")
                ]
            )
        )
        users = getattr(result, "users", []) or []
        for u in users:
            uid = getattr(u, "id", None)
            if uid:
                return int(uid)
    except Exception:
        return None
    return None


@app.post("/resolve_contact")
async def resolve_contact(payload: Dict[str, Any]):
    account = str(payload.get("account", "")).strip()
    client: Client
    if account:
        client = get_or_create_client(account)
        await ensure_client_connected(client)
    else:
        await ensure_started()
        client = bot
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
        uid = await _resolve_user_by_phone_client(client, raw_phone)
        if uid:
            return {"ok": True, "user_id": uid, "chat_id": uid}

        # Допускаем, что в поле телефона ввели user_id (цифры без знаков)
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
                type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
            except Exception:
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


# ==== ГЕНЕРАЦИЯ ОТВЕТА ЧЕРЕЗ CLAUDE ====

ANTHROPIC_API_KEY = config("ANTHROPIC_API_KEY", default="")

@app.post("/generate_reply")
async def generate_reply(payload: Dict[str, Any]):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")
    account = str(payload.get("account", "")).strip()
    chat_id = payload.get("chat_id")
    if chat_id is None:
        raise HTTPException(status_code=400, detail="chat_id is required")
    user_prompt = str(payload.get("prompt", "")).strip()

    client_obj: Client
    if account:
        client_obj = get_or_create_client(account)
        await ensure_client_connected(client_obj)
    else:
        await ensure_started()
        client_obj = bot

    history = []
    async for m in client_obj.get_chat_history(int(chat_id), limit=20):
        text = (m.text or m.caption or "").strip()
        if text:
            role = "assistant" if m.outgoing else "user"
            history.append({"role": role, "content": text})
    history.reverse()

    if not history:
        raise HTTPException(status_code=400, detail="No messages to generate reply from")

    system_msg = user_prompt or "Ты — помощник пользователя в Telegram-переписке. Сгенерируй подходящий ответ на последнее сообщение собеседника. Пиши кратко и по делу. Отвечай на том же языке, что и собеседник."

    import httpx
    try:
        async with httpx.AsyncClient(timeout=30) as http:
            resp = await http.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-sonnet-4-20250514",
                    "max_tokens": 1024,
                    "system": system_msg,
                    "messages": history,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
            reply = "\n".join(text_blocks).strip()
            if not reply:
                raise HTTPException(status_code=500, detail="Empty response from Claude")
            return {"ok": True, "reply": reply}
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {e.response.text}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)