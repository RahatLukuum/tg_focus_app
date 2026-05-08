"""Auth endpoints: send_code, sign_in, /me."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pyrogram.errors import PasswordHashInvalid, SessionPasswordNeeded

from deps.pyrogram_clients import PyrogramClientManager


def make_router(manager: PyrogramClientManager) -> APIRouter:
    router = APIRouter()
    pending_logins: dict[str, str] = {}

    @router.api_route("/auth/send_code", methods=["POST", "OPTIONS"])
    @router.api_route("/auth/send_code/", methods=["POST", "OPTIONS"])
    async def auth_send_code(payload: dict[str, str]):
        phone = payload.get("phone")
        if not phone:
            raise HTTPException(status_code=400, detail="phone is required")

        client = manager.get_or_create(phone)
        await manager.ensure_connected(client)
        try:
            sent = await client.send_code(phone)
            phone_code_hash = (
                getattr(sent, "phone_code_hash", None)
                or getattr(sent, "phone_code", None)
            )
            if not phone_code_hash:
                pending_logins[phone] = ""
                return {"ok": True}
            pending_logins[phone] = phone_code_hash
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

        phone_code_hash = pending_logins.get(phone)
        if not phone_code_hash:
            raise HTTPException(status_code=400, detail="send_code must be called first")

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
