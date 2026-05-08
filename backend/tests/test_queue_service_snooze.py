"""Tests for QueueService snooze + expiry."""
from __future__ import annotations

import pytest

from services.queue_service import QueueService


async def test_snooze_removes_chat_from_queue():
    q = QueueService()
    await q.add("acc1", 1)
    await q.add("acc1", 2)
    await q.snooze("acc1", 1, until_ts=10_000)
    assert await q.get("acc1") == [2]


async def test_snooze_records_until_ts():
    q = QueueService()
    await q.add("acc1", 1)
    await q.snooze("acc1", 1, until_ts=12_345)
    assert await q.snoozed("acc1") == {1: 12_345}


async def test_snooze_chat_not_in_queue_still_records():
    """Snoozing a chat that's not currently in the queue still records it."""
    q = QueueService()
    await q.snooze("acc1", 99, until_ts=12_345)
    assert await q.snoozed("acc1") == {99: 12_345}
    assert await q.get("acc1") == []


async def test_expire_snoozed_returns_due_chats_and_restores_them():
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=100)
    await q.snooze("acc1", 2, until_ts=300)
    expired = await q.expire_snoozed(now_ts=200)
    assert expired == {"acc1": [1]}
    assert await q.get("acc1") == [1]
    assert await q.snoozed("acc1") == {2: 300}


async def test_expire_snoozed_no_due_returns_empty():
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=500)
    assert await q.expire_snoozed(now_ts=100) == {}


async def test_expire_snoozed_handles_multiple_accounts():
    q = QueueService()
    await q.snooze("a", 1, until_ts=100)
    await q.snooze("b", 2, until_ts=100)
    await q.snooze("a", 3, until_ts=500)
    expired = await q.expire_snoozed(now_ts=200)
    assert sorted(expired["a"]) == [1]
    assert sorted(expired["b"]) == [2]
    assert "c" not in expired


async def test_re_add_clears_snooze():
    """Adding a chat normally should clear its snoozed entry."""
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=500)
    await q.add("acc1", 1)
    assert await q.snoozed("acc1") == {}
    assert await q.get("acc1") == [1]


async def test_done_clears_snooze():
    """Marking done on a snoozed chat clears its snooze entry."""
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=500)
    await q.remove("acc1", 1)
    assert await q.snoozed("acc1") == {}
