"""FastAPI dependencies for authorization checks against Pyrogram clients."""
from __future__ import annotations

from fastapi import HTTPException
from pyrogram import Client

from deps.pyrogram_clients import PyrogramClientManager


class AuthDeps:
    """Bound to a single PyrogramClientManager instance at app startup."""

    def __init__(self, manager: PyrogramClientManager) -> None:
        self._manager = manager

    async def get_authorized_client(self, account: str = "") -> Client:
        client = (
            self._manager.get_or_create(account)
            if account
            else self._manager.default
        )
        await self._manager.ensure_connected(client)
        try:
            await client.get_me()
        except Exception:
            raise HTTPException(status_code=401, detail="Not authorized")
        return client
