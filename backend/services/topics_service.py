"""Telegram forum-supergroup topics — TTL-cached wrapper.

Mirrors FolderService pattern: cache results per (account, chat_id) for
ttl_seconds. Returns plain dicts for easy JSON serialization.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _serialize(topic: Any) -> dict[str, Any]:
    """Convert Pyrogram ForumTopic to a JSON-friendly dict."""
    last_text: Optional[str] = None
    top = getattr(topic, "top_message", None)
    if top is not None:
        last_text = (getattr(top, "text", None) or getattr(top, "caption", None) or "").strip() or None
    return {
        "topic_id": int(getattr(topic, "id", 0) or 0),
        "title": getattr(topic, "title", "") or "",
        "icon_color": getattr(topic, "icon_color", None),
        "icon_emoji_id": getattr(topic, "icon_emoji_id", None),
        "unread_count": int(getattr(topic, "unread_count", 0) or 0),
        "last_message_text": last_text,
    }


class TopicsService:
    def __init__(self, manager: Any, ttl_seconds: int = 60) -> None:
        self._manager = manager
        self._ttl = ttl_seconds
        self._cache: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}

    def _client_for(self, account: str):
        if account:
            return self._manager.get_or_create(account)
        return self._manager.default

    async def get_topics(self, account: str, chat_id: int) -> list[dict[str, Any]]:
        key = ((account or "").strip(), int(chat_id))
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and (now - cached[0]) < self._ttl:
            return cached[1]

        client = self._client_for(key[0])
        await self._manager.ensure_connected(client)

        try:
            topics: list[dict[str, Any]] = []
            async for t in client.get_forum_topics(chat_id):
                topics.append(_serialize(t))
        except Exception:
            logger.warning("get_forum_topics failed for chat_id=%s account=%r", chat_id, key[0], exc_info=True)
            topics = []

        self._cache[key] = (now, topics)
        return topics

    async def get_topic_title(self, account: str, chat_id: int, topic_id: int) -> Optional[str]:
        topics = await self.get_topics(account=account, chat_id=chat_id)
        for t in topics:
            if t["topic_id"] == int(topic_id):
                return t["title"]
        return None

    def invalidate(self, account: str = "", chat_id: Optional[int] = None) -> None:
        if chat_id is None:
            for k in list(self._cache.keys()):
                if k[0] == (account or "").strip():
                    self._cache.pop(k, None)
        else:
            self._cache.pop(((account or "").strip(), int(chat_id)), None)
