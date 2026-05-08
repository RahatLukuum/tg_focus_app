"""Tests for services.queue_service.QueueService."""
from __future__ import annotations

import asyncio

import pytest

from services.queue_service import QueueService


async def test_add_unique():
    q = QueueService()
    await q.add("acc1", 1)
    await q.add("acc1", 1)
    await q.add("acc1", 2)
    assert await q.get("acc1") == [1, 2]


async def test_remove_clears_set_and_order():
    q = QueueService()
    await q.add("acc1", 1)
    await q.add("acc1", 2)
    await q.remove("acc1", 1)
    assert await q.get("acc1") == [2]
    # adding again works
    await q.add("acc1", 1)
    assert await q.get("acc1") == [2, 1]


async def test_move_to_end_existing():
    q = QueueService()
    await q.add("acc1", 1)
    await q.add("acc1", 2)
    await q.add("acc1", 3)
    await q.move_to_end("acc1", 1)
    assert await q.get("acc1") == [2, 3, 1]


async def test_move_to_end_inserts_if_missing():
    q = QueueService()
    await q.add("acc1", 1)
    await q.move_to_end("acc1", 99)
    assert await q.get("acc1") == [1, 99]


async def test_replace_resets_account():
    q = QueueService()
    await q.add("acc1", 1)
    await q.replace("acc1", [10, 20])
    assert await q.get("acc1") == [10, 20]


async def test_head_empty_and_filled():
    q = QueueService()
    assert await q.head("acc1") is None
    await q.add("acc1", 7)
    assert await q.head("acc1") == 7


async def test_per_account_isolation():
    q = QueueService()
    await q.add("acc1", 1)
    await q.add("acc2", 2)
    assert await q.get("acc1") == [1]
    assert await q.get("acc2") == [2]


async def test_concurrent_adds_serialize():
    q = QueueService()

    async def add(i: int):
        await q.add("acc1", i)

    await asyncio.gather(*(add(i) for i in range(50)))
    result = await q.get("acc1")
    assert sorted(result) == list(range(50))
    assert len(result) == 50  # no duplicates from race
