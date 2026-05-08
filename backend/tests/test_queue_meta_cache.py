"""Tests for QueueMetaCache (per-(account,chat_id) last_message TTL cache)."""
from __future__ import annotations

import asyncio

from services.queue_meta_cache import QueueMetaCache


async def test_set_and_get():
    c = QueueMetaCache(ttl_seconds=60)
    c.set("acc", 100, {"id": 1, "text": "hi"})
    assert c.get("acc", 100) == {"id": 1, "text": "hi"}


async def test_get_returns_none_on_miss():
    c = QueueMetaCache(ttl_seconds=60)
    assert c.get("acc", 100) is None


async def test_invalidate_chat():
    c = QueueMetaCache(ttl_seconds=60)
    c.set("acc", 100, {"id": 1})
    c.set("acc", 200, {"id": 2})
    c.invalidate("acc", 100)
    assert c.get("acc", 100) is None
    assert c.get("acc", 200) == {"id": 2}


async def test_invalidate_account_clears_all():
    c = QueueMetaCache(ttl_seconds=60)
    c.set("acc1", 100, {"id": 1})
    c.set("acc2", 100, {"id": 2})
    c.invalidate("acc1")
    assert c.get("acc1", 100) is None
    assert c.get("acc2", 100) == {"id": 2}


async def test_ttl_expiry():
    c = QueueMetaCache(ttl_seconds=0)  # immediate expiry
    c.set("acc", 100, {"id": 1})
    await asyncio.sleep(0.01)
    assert c.get("acc", 100) is None
