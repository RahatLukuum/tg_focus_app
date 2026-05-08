"""Tests for services.state_store.JsonStore."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from services.state_store import JsonStore


@pytest.fixture
def store(tmp_state_dir: Path) -> JsonStore:
    return JsonStore(tmp_state_dir / "data.json", default_factory=list)


async def test_load_returns_default_when_file_missing(store: JsonStore):
    assert await store.load() == []


async def test_save_then_load_roundtrip(store: JsonStore):
    await store.save([{"id": "1", "value": "hello"}])
    assert await store.load() == [{"id": "1", "value": "hello"}]


async def test_update_applies_mutator_atomically(store: JsonStore):
    await store.save([{"id": "1"}])
    new_data = await store.update(lambda data: data + [{"id": "2"}])
    assert new_data == [{"id": "1"}, {"id": "2"}]
    assert await store.load() == [{"id": "1"}, {"id": "2"}]


async def test_corrupted_json_returns_default(store: JsonStore, tmp_state_dir: Path):
    (tmp_state_dir / "data.json").write_text("not valid json {{{")
    # On corrupted file we fall back to default and rename the file aside.
    assert await store.load() == []


async def test_concurrent_updates_serialize(tmp_state_dir: Path):
    store = JsonStore(tmp_state_dir / "counter.json", default_factory=lambda: {"n": 0})

    async def increment(by: int):
        await store.update(lambda d: {"n": d["n"] + by})

    await asyncio.gather(*(increment(1) for _ in range(20)))
    assert (await store.load())["n"] == 20


async def test_atomic_write_no_partial_file(store: JsonStore, tmp_state_dir: Path):
    """If save raises mid-write, the original file must remain intact."""
    await store.save([{"id": "original"}])

    class Boom(Exception):
        pass

    # Monkey-patch json.dump to fail after writing some bytes.
    real_dump = json.dump
    call_count = {"n": 0}

    def flaky_dump(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise Boom("simulated mid-write failure")
        return real_dump(*args, **kwargs)

    import services.state_store as m

    m.json.dump = flaky_dump  # type: ignore
    try:
        with pytest.raises(Boom):
            await store.save([{"id": "new"}])
    finally:
        m.json.dump = real_dump  # type: ignore

    # Original content preserved.
    assert await store.load() == [{"id": "original"}]
