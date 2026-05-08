"""In-memory queue of chat IDs awaiting user attention.

Persistence is optionally provided via JsonStore (Plan 4). Without a store,
state is lost on restart, which matches the original behavior.
"""
from __future__ import annotations

import asyncio
from typing import Optional

from services.state_store import JsonStore


class QueueService:
    """Per-account ordered queue of chat IDs.

    Account "" represents the default (single-account) bot.
    """

    def __init__(self, store: Optional[JsonStore] = None) -> None:
        self._order: dict[str, list[int]] = {}
        self._set: dict[str, set[int]] = {}
        self._snoozed: dict[str, dict[int, int]] = {}
        self._lock = asyncio.Lock()
        self._store = store

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    async def load(self) -> None:
        """Load persisted state from disk. Call once at startup if a store is set."""
        if self._store is None:
            return
        data = await self._store.load()
        async with self._lock:
            queues = data.get("queues", {})
            snoozed = data.get("snoozed", {})
            self._order = {k: list(v) for k, v in queues.items()}
            self._set = {k: set(v) for k, v in queues.items()}
            self._snoozed = {
                k: {int(cid): int(ts) for cid, ts in by_chat.items()}
                for k, by_chat in snoozed.items()
            }

    def _persist_unlocked(self) -> dict:
        return {
            "queues": {k: list(v) for k, v in self._order.items()},
            "snoozed": {
                k: {str(cid): ts for cid, ts in by_chat.items()}
                for k, by_chat in self._snoozed.items()
            },
        }

    async def _save(self) -> None:
        """Persist current state. Must be called OUTSIDE the lock."""
        if self._store is None:
            return
        async with self._lock:
            data = self._persist_unlocked()
        await self._store.save(data)

    # ------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------

    async def add(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id not in self._set[account]:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)
            # Clear any existing snooze entry for this chat
            if account in self._snoozed:
                self._snoozed[account].pop(chat_id, None)
                if not self._snoozed[account]:
                    self._snoozed.pop(account)
        await self._save()

    async def remove(self, account: str, chat_id: int) -> None:
        async with self._lock:
            if account in self._set and chat_id in self._set[account]:
                self._set[account].discard(chat_id)
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass
            # Clear snooze entry regardless of whether the chat was in queue
            if account in self._snoozed:
                self._snoozed[account].pop(chat_id, None)
                if not self._snoozed[account]:
                    self._snoozed.pop(account)
        await self._save()

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
        await self._save()

    async def replace(self, account: str, chat_ids: list[int]) -> None:
        async with self._lock:
            self._order[account] = list(chat_ids)
            self._set[account] = set(chat_ids)
        await self._save()

    # ------------------------------------------------------------------
    # Snooze
    # ------------------------------------------------------------------

    async def snooze(self, account: str, chat_id: int, until_ts: int) -> None:
        """Remove chat_id from the active queue and record a snooze until until_ts."""
        async with self._lock:
            self._ensure_account(account)
            if chat_id in self._set[account]:
                self._set[account].discard(chat_id)
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass
            self._snoozed.setdefault(account, {})[chat_id] = int(until_ts)
        await self._save()

    async def snoozed(self, account: str) -> dict[int, int]:
        """Return a copy of the snooze map for account."""
        async with self._lock:
            return dict(self._snoozed.get(account, {}))

    async def expire_snoozed(self, now_ts: int) -> dict[str, list[int]]:
        """Move chats whose snooze has passed back into the queue.

        Returns a dict[account, list[chat_id]] of restored chats per account.
        """
        async with self._lock:
            restored: dict[str, list[int]] = {}
            for account, by_chat in list(self._snoozed.items()):
                due = [cid for cid, ts in by_chat.items() if ts <= now_ts]
                if not due:
                    continue
                self._ensure_account(account)
                for cid in due:
                    by_chat.pop(cid, None)
                    if cid not in self._set[account]:
                        self._set[account].add(cid)
                        self._order[account].append(cid)
                if not by_chat:
                    self._snoozed.pop(account, None)
                restored[account] = due
        if restored:
            await self._save()
        return restored

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get(self, account: str) -> list[int]:
        async with self._lock:
            return list(self._order.get(account, []))

    async def head(self, account: str) -> Optional[int]:
        order = await self.get(account)
        return order[0] if order else None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure_account(self, account: str) -> None:
        self._order.setdefault(account, [])
        self._set.setdefault(account, set())
