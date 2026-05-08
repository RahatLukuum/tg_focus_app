"""Tests that /messages does not drop content-empty messages for the self-chat."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


class _Auth:
    def __init__(self, client): self._client = client
    async def get_authorized_client(self, account): return self._client


class _Manager:
    def __init__(self, client):
        self._client = client; self.default = client
    def get_or_create(self, account): return self._client
    async def ensure_connected(self, c): return None


def _msg(mid, text=None, outgoing=False):
    return SimpleNamespace(
        id=mid, text=text, caption=None,
        date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=555, first_name="Me", last_name=None),
        sender_chat=None, outgoing=outgoing,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        chat=SimpleNamespace(id=555),
    )


def test_messages_for_self_chat_keeps_empty_messages():
    me_id = 555
    history = [_msg(1, text=None, outgoing=True), _msg(2, text="hi", outgoing=True)]

    def fake_history(chat_id, **kw):
        async def gen():
            for m in history:
                yield m
        return gen()

    client = MagicMock()
    client.me = SimpleNamespace(id=me_id)
    async def get_me(): return client.me
    client.get_me = get_me
    client.get_chat_history = fake_history

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.get(f"/messages?chat_id={me_id}")
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()["messages"]]
    assert 1 in ids and 2 in ids


def test_messages_for_other_chat_still_filters_empty():
    history = [_msg(1, text=None), _msg(2, text="hi")]

    def fake_history(chat_id, **kw):
        async def gen():
            for m in history:
                yield m
        return gen()

    client = MagicMock()
    client.me = SimpleNamespace(id=555)
    async def get_me(): return client.me
    client.get_me = get_me
    client.get_chat_history = fake_history

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.get("/messages?chat_id=100")
    ids = [m["id"] for m in r.json()["messages"]]
    assert ids == [2]
