"""Tests for the read-inbox raw-update handler factory."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from pyrogram.raw.types import (
    PeerChannel,
    PeerChat,
    PeerUser,
    UpdateReadChannelInbox,
    UpdateReadHistoryInbox,
)

from handlers.read_inbox import _resolve_chat_id, make_read_inbox_handler
from services.queue_service import QueueService


def _user_read(user_id: int, still_unread: int = 0) -> UpdateReadHistoryInbox:
    return UpdateReadHistoryInbox(
        peer=PeerUser(user_id=user_id),
        max_id=999,
        still_unread_count=still_unread,
        pts=1,
        pts_count=1,
    )


def _basic_group_read(chat_id: int, still_unread: int = 0) -> UpdateReadHistoryInbox:
    return UpdateReadHistoryInbox(
        peer=PeerChat(chat_id=chat_id),
        max_id=999,
        still_unread_count=still_unread,
        pts=1,
        pts_count=1,
    )


def _channel_read(channel_id: int, still_unread: int = 0) -> UpdateReadChannelInbox:
    return UpdateReadChannelInbox(
        channel_id=channel_id,
        max_id=999,
        still_unread_count=still_unread,
        pts=1,
        folder_id=None,
    )


def test_resolve_chat_id_user():
    assert _resolve_chat_id(_user_read(42)) == 42


def test_resolve_chat_id_basic_group():
    # Basic group: PeerChat(123) → -123
    assert _resolve_chat_id(_basic_group_read(123)) == -123


def test_resolve_chat_id_channel():
    # Channel: UpdateReadChannelInbox(456) → -1000000000456
    assert _resolve_chat_id(_channel_read(456)) == -1_000_000_000_456


async def test_read_user_inbox_removes_from_queue():
    qs = QueueService()
    await qs.add("acc", 42)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_read_inbox_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), update=_user_read(42), users={}, chats={})

    assert await qs.get("acc") == []
    bcast.broadcast.assert_awaited_once()
    payload = bcast.broadcast.call_args.args[0]
    assert payload == {
        "type": "queue_update",
        "account": "acc",
        "chat_id": 42,
        "removed": True,
    }
    cache.invalidate.assert_called_once_with("acc", 42)


async def test_still_unread_messages_noop():
    qs = QueueService()
    await qs.add("acc", 42)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    handler = make_read_inbox_handler(qs, bcast, "acc")

    await handler(
        client=MagicMock(), update=_user_read(42, still_unread=3),
        users={}, chats={},
    )

    assert await qs.get("acc") == [42]
    bcast.broadcast.assert_not_awaited()


async def test_chat_not_in_queue_noop():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    handler = make_read_inbox_handler(qs, bcast, "acc")

    await handler(client=MagicMock(), update=_user_read(42), users={}, chats={})

    bcast.broadcast.assert_not_awaited()


async def test_channel_read_removes_from_queue():
    qs = QueueService()
    canonical_id = -1_000_000_000_456
    await qs.add("acc", canonical_id)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    handler = make_read_inbox_handler(qs, bcast, "acc")

    await handler(client=MagicMock(), update=_channel_read(456), users={}, chats={})

    assert await qs.get("acc") == []
    bcast.broadcast.assert_awaited_once()


async def test_unrelated_update_ignored():
    qs = QueueService()
    await qs.add("acc", 42)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    handler = make_read_inbox_handler(qs, bcast, "acc")

    # Send something that isn't a read-inbox update
    await handler(
        client=MagicMock(), update=MagicMock(spec=[]),
        users={}, chats={},
    )

    assert await qs.get("acc") == [42]
    bcast.broadcast.assert_not_awaited()
