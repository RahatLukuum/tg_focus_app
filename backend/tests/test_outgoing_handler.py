"""Tests for the outgoing-message handler factory."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from handlers.outgoing import make_outgoing_handler
from services.queue_service import QueueService


def _msg(chat_id: int, chat_type: str = "private", outgoing: bool = True):
    return SimpleNamespace(
        chat=SimpleNamespace(id=chat_id, type=SimpleNamespace(value=chat_type), title="X"),
        text="ok", caption=None, date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=42, first_name="Me", last_name=None),
        sender_chat=None, outgoing=outgoing,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        id=1,
    )


async def test_outgoing_in_queued_chat_removes_from_queue():
    qs = QueueService()
    await qs.add("acc", 100)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_outgoing_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), message=_msg(100))

    assert await qs.get("acc") == []
    bcast.broadcast.assert_awaited_once()
    payload = bcast.broadcast.call_args.args[0]
    assert payload["type"] == "queue_update"
    assert payload["chat_id"] == 100
    cache.invalidate.assert_called_once_with("acc", 100)


async def test_outgoing_in_unqueued_chat_is_noop():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_outgoing_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), message=_msg(999))

    bcast.broadcast.assert_not_awaited()
    cache.invalidate.assert_not_called()


async def test_outgoing_unsupported_chat_type_is_noop():
    qs = QueueService()
    await qs.add("acc", 100)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock()
    handler = make_outgoing_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), message=_msg(100, chat_type="channel"))

    assert await qs.get("acc") == [100]
    bcast.broadcast.assert_not_awaited()
