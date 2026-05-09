"""Tests for TopicsService TTL cache.

The service uses raw MTProto (``channels.GetForumTopics``) under the hood
since Pyrogram 2.0.106 does not expose a high-level ``get_forum_topics``
method. Tests mock ``client.resolve_peer`` and ``client.invoke``.
"""
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
    )


class _FakeManager:
    def __init__(self, client):
        self._client = client
        self.default = client

    def get_or_create(self, account: str):
        return self._client

    async def ensure_connected(self, client):
        return None


def _make_client(topics: list, *, raise_on_invoke: Exception | None = None):
    """Return a mock Pyrogram client whose raw ``invoke`` returns ``topics``.

    ``resolve_peer`` returns a fake InputPeerChannel-like object with the
    fields TopicsService needs to build an ``InputChannel``.
    """
    client = MagicMock()
    client.resolve_peer = AsyncMock(
        return_value=SimpleNamespace(channel_id=12345, access_hash=67890)
    )
    if raise_on_invoke is not None:
        client.invoke = AsyncMock(side_effect=raise_on_invoke)
    else:
        client.invoke = AsyncMock(
            return_value=SimpleNamespace(topics=topics)
        )
    return client


async def test_get_topics_caches_within_ttl():
    client = _make_client([_topic(1, "General"), _topic(2, "Bugs")])
    svc = TopicsService(_FakeManager(client), ttl_seconds=60)

    first = await svc.get_topics(account="", chat_id=-100123)
    second = await svc.get_topics(account="", chat_id=-100123)

    assert [t["topic_id"] for t in first] == [1, 2]
    assert first == second
    # Should have only invoked Pyrogram once due to caching.
    assert client.invoke.call_count == 1


async def test_get_topics_returns_empty_on_error():
    client = _make_client([], raise_on_invoke=RuntimeError("not a forum"))
    svc = TopicsService(_FakeManager(client))

    result = await svc.get_topics(account="", chat_id=-100123)

    assert result == []


async def test_get_topics_returns_empty_when_resolve_peer_fails():
    client = MagicMock()
    client.resolve_peer = AsyncMock(side_effect=ValueError("peer not found"))
    client.invoke = AsyncMock()
    svc = TopicsService(_FakeManager(client))

    result = await svc.get_topics(account="", chat_id=-100123)

    assert result == []
    # invoke should never be called if peer resolution fails.
    assert client.invoke.call_count == 0


async def test_get_topics_returns_empty_for_non_channel_peer():
    """If resolve_peer returns a user/chat peer (no channel_id), bail out."""
    client = MagicMock()
    client.resolve_peer = AsyncMock(return_value=SimpleNamespace(user_id=42))
    client.invoke = AsyncMock()
    svc = TopicsService(_FakeManager(client))

    result = await svc.get_topics(account="", chat_id=42)

    assert result == []
    assert client.invoke.call_count == 0


async def test_get_topic_title_returns_none_when_missing():
    client = _make_client([_topic(1, "General")])
    svc = TopicsService(_FakeManager(client))

    title = await svc.get_topic_title(account="", chat_id=-100123, topic_id=999)

    assert title is None


async def test_get_topic_title_returns_cached_match():
    client = _make_client([_topic(1, "General"), _topic(2, "Bugs")])
    svc = TopicsService(_FakeManager(client))

    # Prime cache
    await svc.get_topics(account="", chat_id=-100123)
    # Should not refetch
    title = await svc.get_topic_title(account="", chat_id=-100123, topic_id=2)

    assert title == "Bugs"
    assert client.invoke.call_count == 1
