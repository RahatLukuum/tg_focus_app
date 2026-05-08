"""In-memory TTL cache for response bodies.

Thundering-herd protection: concurrent get_or_load() calls for the same key
share the first loader's result (the second waits on an asyncio.Event rather
than re-running the loader). Loader exceptions are NOT cached — the next call
will retry.
"""
from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class _Pending(Generic[V]):
    __slots__ = ("event", "value", "error")

    def __init__(self) -> None:
        self.event: asyncio.Event = asyncio.Event()
        self.value: V | None = None
        self.error: BaseException | None = None


class TtlCache(Generic[K, V]):
    """Async TTL cache with per-key thundering-herd protection."""

    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[K, tuple[float, V]] = {}
        self._inflight: dict[K, _Pending[V]] = {}
        self._lock = asyncio.Lock()

    async def get_or_load(self, key: K, loader: Callable[[], Awaitable[V]]) -> V:
        now = time.monotonic()

        # Fast path: hit
        async with self._lock:
            entry = self._entries.get(key)
            if entry and (now - entry[0]) < self._ttl:
                return entry[1]
            # Are we already loading this key?
            pending = self._inflight.get(key)
            if pending is None:
                pending = _Pending[V]()
                self._inflight[key] = pending
                first_caller = True
            else:
                first_caller = False

        if first_caller:
            try:
                value = await loader()
            except BaseException as e:
                pending.error = e
                pending.event.set()
                async with self._lock:
                    self._inflight.pop(key, None)
                raise
            async with self._lock:
                self._entries[key] = (time.monotonic(), value)
                self._inflight.pop(key, None)
            pending.value = value
            pending.event.set()
            return value
        else:
            await pending.event.wait()
            if pending.error is not None:
                raise pending.error
            assert pending.value is not None
            return pending.value

    def invalidate(self, key: K) -> None:
        """Remove a single key from the cache."""
        self._entries.pop(key, None)

    def invalidate_all(self) -> None:
        """Clear all cached entries."""
        self._entries.clear()
