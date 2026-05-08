"""Per-(account, chat_id) TTL cache for queue last-message snapshots.

Used by /queue?meta=true to avoid hammering Telegram on every poll.
"""
from __future__ import annotations

import time
from typing import Any, Optional


class QueueMetaCache:
    """Synchronous TTL cache keyed by (account, chat_id).

    Stores small per-chat snapshots (e.g. last_message dicts) for queue meta
    responses. Entries expire after ``ttl_seconds`` of monotonic time. Account
    keys are normalized via strip() so empty/whitespace accounts collapse to
    the same bucket.
    """

    def __init__(self, ttl_seconds: int = 30) -> None:
        self._ttl = ttl_seconds
        self._store: dict[tuple[str, int], tuple[float, Any]] = {}

    def get(self, account: str, chat_id: int) -> Optional[Any]:
        """Return cached value for (account, chat_id) or None if missing/expired."""
        key = ((account or "").strip(), int(chat_id))
        item = self._store.get(key)
        if not item:
            return None
        ts, value = item
        if (time.monotonic() - ts) > self._ttl:
            self._store.pop(key, None)
            return None
        return value

    def set(self, account: str, chat_id: int, value: Any) -> None:
        """Store ``value`` for (account, chat_id) with current monotonic timestamp."""
        key = ((account or "").strip(), int(chat_id))
        self._store[key] = (time.monotonic(), value)

    def invalidate(self, account: str = "", chat_id: Optional[int] = None) -> None:
        """Drop a single (account, chat_id) entry, or all entries for an account."""
        norm = (account or "").strip()
        if chat_id is None:
            for k in list(self._store.keys()):
                if k[0] == norm:
                    self._store.pop(k, None)
        else:
            self._store.pop((norm, int(chat_id)), None)
