"""Tests that QueueService state persists across instances via JsonStore."""
from __future__ import annotations

from pathlib import Path

import pytest

from services.queue_service import QueueService
from services.state_store import JsonStore


@pytest.fixture
def state_path(tmp_state_dir: Path) -> Path:
    return tmp_state_dir / "queue_state.json"


def _make_store(path: Path) -> JsonStore:
    return JsonStore(
        path,
        default_factory=lambda: {"queues": {}, "snoozed": {}},
    )


async def test_queue_persists_across_instances(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.add("acc1", 100)
    await q1.add("acc1", 200)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.get("acc1") == [100, 200]


async def test_snooze_persists_across_instances(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.snooze("acc1", 99, until_ts=12_345)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.snoozed("acc1") == {99: 12_345}


async def test_remove_persists(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.add("acc1", 1)
    await q1.add("acc1", 2)
    await q1.remove("acc1", 1)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.get("acc1") == [2]


async def test_load_default_when_no_file(state_path):
    q = QueueService(store=_make_store(state_path))
    await q.load()
    assert await q.get("acc1") == []
    assert await q.snoozed("acc1") == {}


async def test_in_memory_when_no_store():
    """Without a store, QueueService operates in-memory only."""
    q = QueueService()
    await q.add("acc1", 1)
    assert await q.get("acc1") == [1]


async def test_expire_persists_restored_chats(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.snooze("acc1", 1, until_ts=100)
    await q1.expire_snoozed(now_ts=200)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.get("acc1") == [1]
    assert await q2.snoozed("acc1") == {}
