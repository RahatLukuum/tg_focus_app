"""In-memory queue of chat IDs awaiting user attention.

Persistence is added in a later plan (Plan 4). For now state is lost on restart,
which matches existing behavior.
"""
from __future__ import annotations

import asyncio
from typing import Optional


class QueueService:
    """Per-account ordered queue of chat IDs.

    Account "" represents the default (single-account) bot.
    """

    def __init__(self) -> None:
        self._order: dict[str, list[int]] = {}
        self._set: dict[str, set[int]] = {}
        self._lock = asyncio.Lock()

    async def add(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id not in self._set[account]:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)

    async def remove(self, account: str, chat_id: int) -> None:
        async with self._lock:
            if account not in self._set:
                return
            if chat_id in self._set[account]:
                self._set[account].discard(chat_id)
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass

    async def move_to_end(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id in self._set[account]:
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass
                self._order[account].append(chat_id)
            else:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)

    async def get(self, account: str) -> list[int]:
        async with self._lock:
            return list(self._order.get(account, []))

    async def replace(self, account: str, chat_ids: list[int]) -> None:
        async with self._lock:
            self._order[account] = list(chat_ids)
            self._set[account] = set(chat_ids)

    async def head(self, account: str) -> Optional[int]:
        order = await self.get(account)
        return order[0] if order else None

    def _ensure_account(self, account: str) -> None:
        self._order.setdefault(account, [])
        self._set.setdefault(account, set())
