"""Auth endpoints: send_code, sign_in, /me."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pyrogram.errors import PasswordHashInvalid, SessionPasswordNeeded

from deps.pyrogram_clients import PyrogramClientManager

PENDING_TTL_SECONDS = 600  # 10 min — phone_code_hash valid window
RATE_LIMIT_SECONDS = 30   # min interval between send_code attempts per phone


def make_router(manager: PyrogramClientManager) -> APIRouter:
    router = APIRouter()
    pending_logins: dict[str, tuple[str, float]] = {}
    last_send_at: dict[str, float] = {}

    def _purge_expired(now: float) -> None:
        expired = [p for p, (_, exp) in pending_logins.items() if exp < now]
        for p in expired:
            pending_logins.pop(p, None)

    @router.api_route("/auth/send_code", methods=["POST", "OPTIONS"])
    @router.api_route("/auth/send_code/", methods=["POST", "OPTIONS"])
    async def auth_send_code(payload: dict[str, str]):
        phone = payload.get("phone")
        if not phone:
            raise HTTPException(status_code=400, detail="phone is required")

        now = time.monotonic()
        last = last_send_at.get(phone, 0)
        if now - last < RATE_LIMIT_SECONDS:
            wait = int(RATE_LIMIT_SECONDS - (now - last))
            raise HTTPException(status_code=429, detail=f"Try again in {wait}s")
        last_send_at[phone] = now
        _purge_expired(now)

        client = manager.get_or_create(phone)
        await manager.ensure_connected(client)
        try:
            sent = await client.send_code(phone)
            phone_code_hash = (
                getattr(sent, "phone_code_hash", None)
                or getattr(sent, "phone_code", None)
            )
            if not phone_code_hash:
                pending_logins[phone] = ("", now + PENDING_TTL_SECONDS)
                return {"ok": True}
            pending_logins[phone] = (phone_code_hash, now + PENDING_TTL_SECONDS)
            return {"ok": True, "phone_code_hash": phone_code_hash}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.api_route("/auth/sign_in", methods=["POST", "OPTIONS"])
    @router.api_route("/auth/sign_in/", methods=["POST", "OPTIONS"])
    async def auth_sign_in(payload: dict[str, str]):
        phone = payload.get("phone")
        code = payload.get("code")
        password = payload.get("password")

        if not phone or not code:
            raise HTTPException(status_code=400, detail="phone and code are required")

        now = time.monotonic()
        _purge_expired(now)

        entry = pending_logins.get(phone)
        if not entry:
            raise HTTPException(
                status_code=400, detail="send_code must be called first or code expired"
            )
        phone_code_hash, _exp = entry

        client = manager.get_or_create(phone)
        await manager.ensure_connected(client)

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
        return {
            "ok": True,
            "me": (
                {"id": me.id, "first_name": me.first_name, "username": me.username}
                if me
                else None
            ),
        }

    @router.get("/me")
    async def get_me(account: str = ""):
        try:
            client = manager.get_or_create(account) if account else manager.default
            await manager.ensure_connected(client)
            me = await client.get_me()
            return {
                "authorized": True,
                "me": {
                    "id": me.id,
                    "first_name": me.first_name,
                    "username": me.username,
                },
            }
        except Exception:
            return {"authorized": False}

    return router
