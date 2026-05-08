"""Multi-account Pyrogram client manager.

Each phone number gets its own Client. Default `bot` is named after LOGIN env.
Incoming-message handler is attached at client creation time.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable, Optional

from pyrogram import Client, filters
from pyrogram.handlers import MessageHandler
from pyrogram.types import Message

from config import AppConfig

logger = logging.getLogger(__name__)


class PyrogramClientManager:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._clients: dict[str, Client] = {}
        self._handler_factory: Optional[Callable[[Client, str], Callable]] = None

        proxy = cfg.proxy.to_pyrogram_dict() if cfg.proxy else None
        self._default = Client(
            name=cfg.login,
            api_id=cfg.api_id,
            api_hash=cfg.api_hash,
            proxy=proxy,
            workdir=str(cfg.session_dir),
        )

    @property
    def default(self) -> Client:
        return self._default

    @property
    def all_accounts(self) -> list[str]:
        return list(self._clients.keys())

    def set_incoming_handler_factory(
        self, factory: Callable[[Client, str], Callable]
    ) -> None:
        """Register a factory: factory(client, account) -> async handler(client, message)."""
        self._handler_factory = factory

    def get_or_create(self, account: str) -> Client:
        key = account.strip()
        if not key:
            return self._default
        if key in self._clients:
            return self._clients[key]
        proxy = self._cfg.proxy.to_pyrogram_dict() if self._cfg.proxy else None
        client = Client(
            name=key,
            api_id=self._cfg.api_id,
            api_hash=self._cfg.api_hash,
            proxy=proxy,
            workdir=str(self._cfg.session_dir),
        )
        if self._handler_factory:
            handler = self._handler_factory(client, key)
            client.add_handler(MessageHandler(handler, filters.incoming & ~filters.service))
        self._clients[key] = client
        return client

    async def ensure_connected(self, client: Client) -> None:
        if not client.is_connected:
            try:
                await client.connect()
            except Exception as e:
                logger.warning("connect failed once, retrying: %s", e)
                await client.connect()

    async def stop_all(self) -> None:
        for c in [self._default, *self._clients.values()]:
            try:
                await c.stop()
            except Exception:
                logger.warning("client.stop() failed during shutdown", exc_info=True)
