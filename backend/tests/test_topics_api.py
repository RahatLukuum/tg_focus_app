"""Tests for /topics endpoint."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.topics import make_router


class _FakeTopics:
    def __init__(self, data):
        self._data = data
        self.calls = []

    async def get_topics(self, account: str, chat_id: int):
        self.calls.append((account, chat_id))
        if isinstance(self._data, Exception):
            raise self._data
        return self._data


class _FakeAuth:
    async def get_authorized_client(self, account: str):
        return object()


def _app(topics_service):
    app = FastAPI()
    app.include_router(make_router(topics_service=topics_service, auth=_FakeAuth()))
    return TestClient(app)


def test_topics_returns_serialized_list():
    topics = _FakeTopics([
        {"topic_id": 1, "title": "General", "icon_color": 9367192, "icon_emoji_id": None,
         "unread_count": 0, "last_message_text": None},
    ])
    client = _app(topics)
    r = client.get("/topics?chat_id=-100123")
    assert r.status_code == 200
    assert r.json() == {
        "chat_id": -100123,
        "topics": [
            {"topic_id": 1, "title": "General", "icon_color": 9367192, "icon_emoji_id": None,
             "unread_count": 0, "last_message_text": None},
        ],
    }


def test_topics_passes_account_query():
    topics = _FakeTopics([])
    client = _app(topics)
    client.get("/topics?chat_id=-100123&account=%2B79991234567")
    assert topics.calls == [("+79991234567", -100123)]


def test_topics_returns_404_when_chat_id_missing():
    topics = _FakeTopics([])
    client = _app(topics)
    r = client.get("/topics")
    assert r.status_code == 422  # FastAPI validation
