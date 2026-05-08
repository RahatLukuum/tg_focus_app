"""Incoming handler enriches broadcast with topic info and invalidates cache."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from handlers.incoming import make_incoming_handler
from services.queue_service import QueueService


class _FakeFolderService:
    def is_archived(self, account, chat_id): return False
    def get_cached_chat_folders(self, account, chat_id): return [2]


class _FakeTopicsService:
    def __init__(self, title): self._title = title
    async def get_topic_title(self, account, chat_id, topic_id): return self._title


def _msg(thread_id):
    return SimpleNamespace(
        chat=SimpleNamespace(id=-100123, type=SimpleNamespace(value="supergroup"), title="Forum"),
        text="hi", caption=None, date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=1, first_name="A", last_name=None),
        sender_chat=None, outgoing=False,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        id=10, message_thread_id=thread_id,
    )


async def test_handler_includes_topic_info_in_broadcasts():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_incoming_handler(
        queue_service=qs, broadcaster=bcast, account="",
        folder_service=_FakeFolderService(),
        topics_service=_FakeTopicsService("General"),
        queue_meta_cache=cache,
    )

    await handler(client=MagicMock(), message=_msg(thread_id=7))

    # Two broadcasts: queue_update + message
    assert bcast.broadcast.await_count == 2
    qu, msg = bcast.broadcast.call_args_list
    qu_payload = qu.args[0]
    msg_payload = msg.args[0]
    assert qu_payload["topic_id"] == 7
    assert msg_payload["topic_id"] == 7
    assert msg_payload["topic_title"] == "General"
    cache.invalidate.assert_called_once_with("", -100123)


async def test_handler_topic_id_none_for_non_forum():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_incoming_handler(
        queue_service=qs, broadcaster=bcast, account="",
        folder_service=_FakeFolderService(),
        topics_service=_FakeTopicsService(None),
        queue_meta_cache=cache,
    )

    await handler(client=MagicMock(), message=_msg(thread_id=None))

    msg_payload = bcast.broadcast.call_args_list[1].args[0]
    assert msg_payload["topic_id"] is None
    assert msg_payload["topic_title"] is None
