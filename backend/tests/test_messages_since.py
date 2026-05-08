"""Integration tests for GET /messages/since (delta-sync endpoint)."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


def _msg(id: int, text: str, *, outgoing: bool = False, ts: int = 1700000000):
    return SimpleNamespace(
        id=id,
        text=text,
        caption=None,
        date=datetime.fromtimestamp(ts),
        from_user=SimpleNamespace(id=42, first_name="X", last_name=None),
        sender_chat=None,
        outgoing=outgoing,
        photo=None,
        video=None,
        voice=None,
        video_note=None,
        document=None,
    )


class _FakeAuth:
    def __init__(self, history: list):
        self._history = history

    async def get_authorized_client(self, account: str = ""):
        async def gen(chat_id, **kwargs):
            min_id = kwargs.get("min_id", 0)
            for m in self._history:
                if m.id > min_id:
                    yield m

        client = MagicMock()
        client.get_chat_history = gen
        return client


def _build_app(history: list):
    app = FastAPI()
    auth = _FakeAuth(history)
    manager = MagicMock()
    manager.ensure_connected = AsyncMock()
    manager.default = MagicMock()
    manager.get_or_create = MagicMock()
    app.include_router(make_router(manager, auth))
    return app


def test_messages_since_returns_only_newer():
    history = [_msg(5, "old"), _msg(10, "newer"), _msg(11, "newest")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=5")
    assert r.status_code == 200
    body = r.json()
    assert body["chat_id"] == 1
    ids = [m["id"] for m in body["messages"]]
    assert ids == [10, 11]


def test_messages_since_empty_when_no_new():
    history = [_msg(5, "old")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=10")
    assert r.status_code == 200
    assert r.json()["messages"] == []


def test_messages_since_requires_since_id():
    history = [_msg(5, "x")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1")
    assert r.status_code == 422  # FastAPI auto-validates required query param


def test_messages_since_respects_limit():
    history = [_msg(i, f"m{i}") for i in range(1, 30)]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=0&limit=5")
    body = r.json()
    assert len(body["messages"]) == 5


def test_messages_since_results_in_chronological_order():
    """Pyrogram returns history newest-first; the response must be reversed
    so the frontend can append in display order."""
    history = [_msg(20, "newest"), _msg(15, "mid"), _msg(10, "oldest")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=0")
    ids = [m["id"] for m in r.json()["messages"]]
    assert ids == [10, 15, 20]
