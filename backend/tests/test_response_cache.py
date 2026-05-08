"""Tests for services.response_cache.TtlCache."""
from __future__ import annotations

import asyncio

import pytest

from services.response_cache import TtlCache


async def test_cache_miss_calls_loader_once():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return 42

    assert await cache.get_or_load("k", loader) == 42
    assert calls["n"] == 1


async def test_cache_hit_within_ttl_skips_loader():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return 42

    await cache.get_or_load("k", loader)
    await cache.get_or_load("k", loader)
    await cache.get_or_load("k", loader)
    assert calls["n"] == 1


async def test_cache_expires_after_ttl():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=0)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return 42

    await cache.get_or_load("k", loader)
    await cache.get_or_load("k", loader)
    assert calls["n"] == 2


async def test_different_keys_dont_share_cache():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    counter = {"n": 0}

    async def loader() -> int:
        counter["n"] += 1
        return counter["n"]

    a = await cache.get_or_load("a", loader)
    b = await cache.get_or_load("b", loader)
    assert a == 1 and b == 2


async def test_invalidate_clears_specific_key():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return calls["n"]

    await cache.get_or_load("k", loader)
    cache.invalidate("k")
    await cache.get_or_load("k", loader)
    assert calls["n"] == 2


async def test_invalidate_all_clears_everything():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return calls["n"]

    await cache.get_or_load("a", loader)
    await cache.get_or_load("b", loader)
    cache.invalidate_all()
    await cache.get_or_load("a", loader)
    await cache.get_or_load("b", loader)
    assert calls["n"] == 4


async def test_concurrent_requests_for_same_key_share_loader():
    """A second concurrent get_or_load for the same missing key must wait for
    the first loader instead of running its own (avoids thundering herd)."""
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    started = asyncio.Event()
    proceed = asyncio.Event()
    calls = {"n": 0}

    async def slow_loader() -> int:
        calls["n"] += 1
        started.set()
        await proceed.wait()
        return 42

    t1 = asyncio.create_task(cache.get_or_load("k", slow_loader))
    await started.wait()
    t2 = asyncio.create_task(cache.get_or_load("k", slow_loader))
    proceed.set()
    a = await t1
    b = await t2
    assert a == b == 42
    assert calls["n"] == 1


async def test_loader_exception_is_not_cached():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def bad_loader() -> int:
        calls["n"] += 1
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        await cache.get_or_load("k", bad_loader)
    with pytest.raises(RuntimeError):
        await cache.get_or_load("k", bad_loader)
    assert calls["n"] == 2  # second call retried
