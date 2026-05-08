"""Tests for services.snooze_worker._tick."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from services.queue_service import QueueService
from services.snooze_worker import _tick


async def test_tick_broadcasts_for_each_restored_chat():
    qs = QueueService()
    await qs.snooze("acc1", 1, until_ts=100)
    await qs.snooze("acc1", 2, until_ts=200)
    await qs.snooze("acc2", 3, until_ts=100)

    bcast = MagicMock()
    bcast.broadcast = AsyncMock()

    # Force "now" by patching time.time in the worker module.
    import services.snooze_worker as worker_mod
    real_time = worker_mod.time.time
    worker_mod.time.time = lambda: 150
    try:
        await _tick(qs, bcast)
    finally:
        worker_mod.time.time = real_time

    # Chats with until_ts <= 150 are restored: 1 and 3 (not 2).
    events = [call.args[0] for call in bcast.broadcast.call_args_list]
    chat_ids_per_account = {(e["account"], e["chat_id"]) for e in events}
    assert ("acc1", 1) in chat_ids_per_account
    assert ("acc2", 3) in chat_ids_per_account
    # acc1's chat 2 stays snoozed
    assert ("acc1", 2) not in chat_ids_per_account
    # All events have the right shape
    for e in events:
        assert e["type"] == "queue_update"
        assert e["reason"] == "snooze_resumed"


async def test_tick_no_broadcasts_when_nothing_due():
    qs = QueueService()
    await qs.snooze("acc1", 1, until_ts=9999999999)
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    await _tick(qs, bcast)
    assert bcast.broadcast.call_count == 0


async def test_tick_swallows_expire_snoozed_errors():
    """If expire_snoozed raises, _tick logs and returns — does not crash worker."""
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()

    qs = MagicMock()
    qs.expire_snoozed = AsyncMock(side_effect=RuntimeError("boom"))

    # Should not raise.
    await _tick(qs, bcast)
    assert bcast.broadcast.call_count == 0
