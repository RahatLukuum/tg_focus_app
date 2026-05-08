"""Tests for topic_id forwarding through /messages and /send_message."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


class _Auth:
    def __init__(self, client): self._client = client
    async def get_authorized_client(self, account): return self._client


class _Manager:
    def __init__(self, client):
        self._client = client
        self.default = client
    def get_or_create(self, account): return self._client
    async def ensure_connected(self, c): return None


def _msg(mid=1):
    return SimpleNamespace(
        id=mid, text="hello", caption=None,
        date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=1, first_name="A", last_name=None),
        sender_chat=None, outgoing=False,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        chat=SimpleNamespace(id=-100123),
    )


def test_get_messages_passes_topic_id_to_pyrogram():
    captured = {}

    def fake_history(chat_id, **kwargs):
        captured.update({"chat_id": chat_id, **kwargs})
        async def gen():
            yield _msg(1)
        return gen()

    client = MagicMock()
    client.get_chat_history = fake_history

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.get("/messages?chat_id=-100123&topic_id=7&limit=10")
    assert r.status_code == 200
    assert captured["chat_id"] == -100123
    assert captured["limit"] == 10
    assert captured["message_thread_id"] == 7


def test_send_message_passes_message_thread_id():
    sent = {}
    async def fake_send(chat_id, text, **kwargs):
        sent.update({"chat_id": chat_id, "text": text, **kwargs})
        return SimpleNamespace(id=999)

    client = MagicMock()
    client.send_message = fake_send

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.post("/send_message", json={
        "chat_id": -100123, "text": "hi", "message_thread_id": 7,
    })
    assert r.status_code == 200
    assert sent["message_thread_id"] == 7
