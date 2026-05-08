"""Tests for /queue?meta=true with last_message and topic enrichment."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService


class _FakeFolders:
    async def get_folders(self, account: str = ""):
        return {"chat_to_folders": {100: [2]}}


class _FakeTopics:
    def __init__(self, mapping):
        self._m = mapping

    async def get_topic_title(self, account, chat_id, topic_id):
        return self._m.get((chat_id, topic_id))


def _msg(mid, text, thread_id=None, from_first="Ivan"):
    return SimpleNamespace(
        id=mid, text=text, caption=None,
        date=datetime(2026, 5, 8, 12, 0),
        from_user=SimpleNamespace(id=1, first_name=from_first, last_name=None),
        sender_chat=None, outgoing=False,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        message_thread_id=thread_id,
    )


class _FakeManager:
    def __init__(self, history_by_chat):
        self._h = history_by_chat
        self.default = self
        self.get_or_create = lambda _a: self
        async def _ensure(client): return None
        self.ensure_connected = _ensure

    def get_chat_history(self, chat_id, limit=1):
        async def gen():
            for m in self._h.get(chat_id, [])[:limit]:
                yield m
        return gen()


async def test_meta_returns_last_message_with_author_and_topic():
    qs = QueueService()
    await qs.add("", 100)
    cache = QueueMetaCache(ttl_seconds=30)
    topics = _FakeTopics({(100, 7): "General"})

    fake_history = {100: [_msg(50, "hello world", thread_id=7, from_first="Ivan")]}
    fake_mgr = _FakeManager(fake_history)

    app = FastAPI()
    app.include_router(
        make_router(
            manager=fake_mgr,
            auth=MagicMock(),
            queue_service=qs,
            folder_service=_FakeFolders(),
            topics_service=topics,
            queue_meta_cache=cache,
        )
    )
    client = TestClient(app)

    r = client.get("/queue?meta=true")
    assert r.status_code == 200
    data = r.json()
    assert len(data["queue"]) == 1
    item = data["queue"][0]
    assert item["chat_id"] == 100
    assert item["topic_id"] == 7
    assert item["topic_title"] == "General"
    last = item["last_message"]
    assert last["text"] == "hello world"
    assert last["from_name"] == "Ivan"
    assert last["outgoing"] is False


async def test_meta_uses_cache_on_second_call():
    qs = QueueService()
    await qs.add("", 100)
    cache = QueueMetaCache(ttl_seconds=30)
    cache.set("", 100, {"id": 99, "text": "cached", "from_name": None, "outgoing": False, "date": 0, "topic_id": None})

    # Manager that would error if called — proves cache short-circuit.
    class _Boom:
        default = None
        get_or_create = staticmethod(lambda _a: None)
        async def ensure_connected(self, _c): raise AssertionError("should not connect")
        async def get_chat_history(self, *a, **kw): raise AssertionError("should not be called")

    app = FastAPI()
    app.include_router(
        make_router(
            manager=_Boom(),
            auth=MagicMock(),
            queue_service=qs,
            folder_service=_FakeFolders(),
            topics_service=_FakeTopics({}),
            queue_meta_cache=cache,
        )
    )
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    assert r.status_code == 200
    item = r.json()["queue"][0]
    assert item["last_message"]["text"] == "cached"
