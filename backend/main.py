from pyrogram import Client, filters
from pyrogram.handlers import MessageHandler
from pyrogram.types import Message
from decouple import config

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

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

bot = Client(name=login, api_id=api_id, api_hash=api_hash, proxy=proxy, workdir=session_dir, in_memory=True)


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


@bot.on_message(filters.incoming & ~filters.service)
async def incoming_handler(client: Client, message: Message):
    chat_id = message.chat.id
    # filter: only private chats
    try:
        ctype = getattr(message.chat, "type", None)
        type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
    except Exception:
        type_name = ""
    if type_name != "private":
        return

    ensure_in_queue(chat_id)

    preview_text = (message.text or message.caption or "").strip()
    author = None
    try:
        if message.from_user:
            author = (message.from_user.first_name or "") + (" " + message.from_user.last_name if message.from_user.last_name else "")
        elif message.sender_chat:
            author = message.sender_chat.title
    except Exception:
        author = None

    # Не шлём пустые текстовые сообщения в realtime, но сохраняем чат в очереди выше
    if preview_text:
        await broadcast(
            {
                "type": "message",
                "account": "",
                "chat_id": chat_id,
                "chat_title": message.chat.title if getattr(message.chat, "title", None) else author or "",
                "message": {
                    "id": message.id,
                    "text": preview_text,
                    "date": int(message.date.timestamp()) if message.date else None,
                    "from_user_id": message.from_user.id if message.from_user else None,
                    "outgoing": message.outgoing,
                },
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

        preview_text = (message.text or message.caption or "").strip()
        author = None
        try:
            if message.from_user:
                author = (message.from_user.first_name or "") + (" " + message.from_user.last_name if message.from_user.last_name else "")
            elif message.sender_chat:
                author = message.sender_chat.title
        except Exception:
            author = None

        if preview_text:
            await broadcast(
                {
                    "type": "message",
                    "account": account,
                    "chat_id": message.chat.id,
                    "chat_title": message.chat.title if getattr(message.chat, "title", None) else author or "",
                    "message": {
                        "id": message.id,
                        "text": preview_text,
                        "date": int(message.date.timestamp()) if message.date else None,
                        "from_user_id": message.from_user.id if message.from_user else None,
                        "outgoing": message.outgoing,
                    },
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
        in_memory=True,
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
    try:
        await client.sign_in(phone_number=phone, phone_code=code, phone_code_hash=phone_code_hash)
    except Exception as e:
        if "SESSION_PASSWORD_NEEDED" in str(e).upper() or "PASSWORD" in str(e).upper():
            if not password:
                raise HTTPException(status_code=401, detail="Two-factor password required")
            await client.check_password(password=password)
        else:
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

@app.get("/dialogs")
async def get_dialogs(limit: int = 100, account: str = ""):
    client: Client
    if account:
        client = get_or_create_client(account)
        await ensure_client_connected(client)
    else:
        await ensure_started()
        client = bot
    # Проверим авторизацию, чтобы не провоцировать интерактивный вход
    try:
        await client.get_me()
    except Exception:
        raise HTTPException(status_code=401, detail="Not authorized")
    dialogs: List[Dict[str, Any]] = []
    async for d in client.get_dialogs(limit=limit):
        chat = d.chat
        # filter: only private chats
        try:
            ctype = getattr(chat, "type", None)
            type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
        except Exception:
            type_name = ""
        if type_name != "private":
            continue
        last_text = (getattr(d.top_message, "text", None) or getattr(d.top_message, "caption", None) or "").strip() if getattr(d, "top_message", None) else None
        if last_text == "":
            last_text = None
        dialogs.append(
            {
                "chat_id": chat.id,
                "title": getattr(chat, "title", None) or (getattr(chat, "first_name", None) or "") + (" " + chat.last_name if getattr(chat, "last_name", None) else ""),
                "type": chat.type.value if hasattr(chat.type, "value") else str(chat.type),
                "username": getattr(chat, "username", None),
                "unread_count": getattr(d, "unread_messages_count", 0),
                "last_message_text": last_text,
            }
        )
    return {"dialogs": dialogs}


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
    # Pyrogram v2: используем get_chat_history
    kwargs: Dict[str, Any] = {"limit": limit}
    # подгружаем более старые сообщения, чем before_id
    if before_id:
        try:
            kwargs["max_id"] = int(before_id) - 1
        except Exception:
            pass
    async for m in client.get_chat_history(chat_id, **kwargs):
        text_content = (m.text or m.caption or "").strip()
        if not text_content:
            # пропускаем пустые сообщения (медиа/сервисные) по запросу пользователя
            continue
        history.append(
            {
                "id": m.id,
                "text": text_content,
                "date": int(m.date.timestamp()) if m.date else None,
                "from_user_id": m.from_user.id if m.from_user else None,
                "outgoing": m.outgoing,
            }
        )
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
    # Топап очереди непрочитанными диалогами (добавляем недостающие даже если очередь не пуста)
    if account:
        try:
            client = get_or_create_client(account)
            await ensure_client_connected(client)
            async for d in client.get_dialogs():
                unread = getattr(d, "unread_messages_count", 0)
                chat = getattr(d, "chat", None)
                if not chat:
                    continue
                # filter only private
                try:
                    ctype = getattr(chat, "type", None)
                    type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
                except Exception:
                    type_name = ""
                if unread and type_name == "private":
                    async with queue_lock:
                        ensure_in_queue_for_account(account, chat.id)
        except Exception:
            pass
        order = queued_chat_order_by_account.get(account, [])
        return {"queue": order}
    else:
        try:
            await ensure_started()
            async for d in bot.get_dialogs():
                unread = getattr(d, "unread_messages_count", 0)
                chat = getattr(d, "chat", None)
                if not chat:
                    continue
                # filter only private
                try:
                    ctype = getattr(chat, "type", None)
                    type_name = getattr(ctype, "value", None) or (str(ctype).lower() if ctype is not None else "")
                except Exception:
                    type_name = ""
                if unread and type_name == "private":
                    ensure_in_queue(chat.id)
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


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)