"""Tests for TopicsService TTL cache."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.topics_service import TopicsService


def _topic(tid: int, title: str):
    return SimpleNamespace(
        id=tid,
        title=title,
        icon_color=9367192,
        icon_emoji_id=None,
        unread_count=0,
        top_message=None,
    )


class _FakeManager:
    def __init__(self, client):
        self._client = client
        self.default = client

    def get_or_create(self, account: str):
        return self._client

    async def ensure_connected(self, client):
        return None


async def _aiter(items):
    for x in items:
        yield x


async def test_get_topics_caches_within_ttl():
    client = MagicMock()
    client.get_forum_topics = MagicMock(return_value=_aiter([_topic(1, "General"), _topic(2, "Bugs")]))
    svc = TopicsService(_FakeManager(client), ttl_seconds=60)

    first = await svc.get_topics(account="", chat_id=-100123)
    second = await svc.get_topics(account="", chat_id=-100123)

    assert [t["topic_id"] for t in first] == [1, 2]
    assert first == second
    # Should have only invoked Pyrogram once due to caching.
    assert client.get_forum_topics.call_count == 1


async def test_get_topics_returns_empty_on_error():
    client = MagicMock()
    def boom(_chat_id):
        raise RuntimeError("not a forum")
    client.get_forum_topics = boom
    svc = TopicsService(_FakeManager(client))

    result = await svc.get_topics(account="", chat_id=-100123)

    assert result == []


async def test_get_topic_title_returns_none_when_missing():
    client = MagicMock()
    client.get_forum_topics = MagicMock(return_value=_aiter([_topic(1, "General")]))
    svc = TopicsService(_FakeManager(client))

    title = await svc.get_topic_title(account="", chat_id=-100123, topic_id=999)

    assert title is None


async def test_get_topic_title_returns_cached_match():
    client = MagicMock()
    client.get_forum_topics = MagicMock(return_value=_aiter([_topic(1, "General"), _topic(2, "Bugs")]))
    svc = TopicsService(_FakeManager(client))

    # Prime cache
    await svc.get_topics(account="", chat_id=-100123)
    # Should not refetch
    title = await svc.get_topic_title(account="", chat_id=-100123, topic_id=2)

    assert title == "Bugs"
    assert client.get_forum_topics.call_count == 1
