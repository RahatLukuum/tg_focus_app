"""Telegram forum-supergroup topics — TTL-cached wrapper.

Mirrors FolderService pattern: cache results per (account, chat_id) for
ttl_seconds. Returns plain dicts for easy JSON serialization.

Pyrogram 2.0.106 does NOT expose a high-level ``client.get_forum_topics``,
so this service drops down to the raw MTProto call
``channels.GetForumTopics``. Errors (e.g. non-forum chat, missing
access_hash, peer resolution failures) are caught and yield an empty list
rather than propagating.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    from pyrogram.raw.functions.channels import GetForumTopics  # type: ignore
    from pyrogram.raw.types import InputChannel  # type: ignore
except Exception:  # pragma: no cover - import-time guard
    GetForumTopics = None  # type: ignore
    InputChannel = None  # type: ignore


def _serialize(topic: Any) -> dict[str, Any]:
    """Convert a raw ForumTopic to a JSON-friendly dict."""
    return {
        "topic_id": int(getattr(topic, "id", 0) or 0),
        "title": getattr(topic, "title", "") or "",
        "icon_color": getattr(topic, "icon_color", None),
        "icon_emoji_id": getattr(topic, "icon_emoji_id", None),
        "unread_count": int(getattr(topic, "unread_count", 0) or 0),
        "last_message_text": None,
    }


class TopicsService:
    """Loads + caches Telegram forum-supergroup topics with a TTL.

    Cache entries are keyed by ``(account, chat_id)`` tuples, where the
    account string is "" for the default account. Each entry expires
    ``ttl_seconds`` after it was last fetched; expired keys are refetched
    transparently on the next call.
    """

    def __init__(self, manager: Any, ttl_seconds: int = 60) -> None:
        self._manager = manager
        self._ttl = ttl_seconds
        self._cache: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}

    def _client_for(self, account: str) -> Any:
        """Return the appropriate Pyrogram client for the given account key.

        Args:
            account: Stripped account identifier. Empty string means default.

        Returns:
            Pyrogram client instance.
        """
        if not account:
            return self._manager.default
        return self._manager.get_or_create(account)

    async def _fetch_raw_topics(self, client: Any, chat_id: int) -> list[Any]:
        """Invoke raw ``channels.GetForumTopics`` and return the topic list.

        Returns an empty list on any error (non-forum chat, missing
        access_hash, peer resolution failure, raw API absent, etc.).
        """
        if GetForumTopics is None or InputChannel is None:
            return []
        try:
            peer = await client.resolve_peer(chat_id)
        except (AttributeError, ValueError, KeyError):
            return []
        except Exception:
            logger.debug("resolve_peer(%s) failed", chat_id, exc_info=True)
            return []

        channel_id = getattr(peer, "channel_id", None)
        access_hash = getattr(peer, "access_hash", None)
        if channel_id is None or access_hash is None:
            # Not a channel/supergroup peer — cannot be a forum.
            return []

        try:
            input_ch = InputChannel(channel_id=channel_id, access_hash=access_hash)
        except (AttributeError, ValueError, TypeError):
            return []

        # ``q`` is Optional[str] in 2.0.106; pass None for "no filter".
        try:
            result = await client.invoke(
                GetForumTopics(
                    channel=input_ch,
                    offset_date=0,
                    offset_id=0,
                    offset_topic=0,
                    limit=100,
                    q=None,
                )
            )
        except (AttributeError, ValueError):
            return []
        except Exception:
            # Most non-forum chats return CHANNEL_FORUM_MISSING or similar.
            logger.debug(
                "channels.GetForumTopics failed for chat_id=%s", chat_id, exc_info=True
            )
            return []

        topics = getattr(result, "topics", None) or []
        # Raw response also may contain ForumTopicDeleted — filter those out
        # by requiring an ``id`` and a ``title``.
        return [t for t in topics if getattr(t, "id", None) is not None and getattr(t, "title", None) is not None]

    async def get_topics(self, account: str, chat_id: int) -> list[dict[str, Any]]:
        """Return the list of topic dicts for a forum-supergroup chat.

        Results are TTL-cached per ``(account, chat_id)``. On any error
        from the raw API call, the failure is logged and an empty list
        is returned (and cached) instead of raising.

        Args:
            account: Account identifier string. Empty string uses default client.
            chat_id: Telegram chat ID of the forum supergroup.

        Returns:
            List of serialized topic dicts; empty on error.
        """
        key = ((account or "").strip(), int(chat_id))
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and (now - cached[0]) < self._ttl:
            return cached[1]

        client = self._client_for(key[0])
        try:
            await self._manager.ensure_connected(client)
        except Exception:
            logger.debug("ensure_connected failed for account=%r", key[0], exc_info=True)

        try:
            raw_topics = await self._fetch_raw_topics(client, chat_id)
            topics = [_serialize(t) for t in raw_topics]
        except (AttributeError, ValueError):
            topics = []
        except Exception:
            logger.warning(
                "topics fetch failed for chat_id=%s account=%r",
                chat_id, key[0], exc_info=True,
            )
            topics = []

        self._cache[key] = (now, topics)
        return topics

    async def get_topic_title(self, account: str, chat_id: int, topic_id: int) -> Optional[str]:
        """Return the title of a specific topic, or None if not found.

        Uses ``get_topics`` under the hood, so the same TTL cache applies.

        Args:
            account: Account identifier string. Empty string uses default client.
            chat_id: Telegram chat ID of the forum supergroup.
            topic_id: Numeric topic ID to look up.

        Returns:
            Topic title string, or ``None`` if no matching topic_id exists.
        """
        topics = await self.get_topics(account=account, chat_id=chat_id)
        for t in topics:
            if t["topic_id"] == int(topic_id):
                return t["title"]
        return None

    def invalidate(self, account: str = "", chat_id: Optional[int] = None) -> None:
        """Drop cached topic entries for an account, optionally narrowing by chat.

        Args:
            account: Account identifier string. Empty string uses default client.
            chat_id: If provided, only that ``(account, chat_id)`` entry is
                cleared. If ``None``, all cached entries belonging to the
                account are cleared.
        """
        if chat_id is None:
            for k in list(self._cache.keys()):
                if k[0] == (account or "").strip():
                    self._cache.pop(k, None)
        else:
            self._cache.pop(((account or "").strip(), int(chat_id)), None)
