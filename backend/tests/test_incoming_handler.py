"""Tests for the incoming-message handler factory."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from handlers.incoming import make_incoming_handler
from services.queue_service import QueueService


class _FakeFolderService:
    def __init__(self, archived: set[int] | None = None):
        self._archived = archived or set()

    def is_archived(self, account: str, chat_id: int) -> bool:
        return chat_id in self._archived


def _make_message(chat_id: int, chat_type: str, text: str = "hi", outgoing: bool = False):
    return SimpleNamespace(
        chat=SimpleNamespace(
            id=chat_id, type=SimpleNamespace(value=chat_type), title="X"
        ),
        text=text,
        caption=None,
        date=datetime(2026, 5, 8, 12, 0),
        from_user=SimpleNamespace(id=42, first_name="Ivan", last_name=None),
        sender_chat=None,
        outgoing=outgoing,
        photo=None,
        video=None,
        voice=None,
        video_note=None,
        document=None,
        id=1001,
    )


async def test_handler_accepts_supergroup():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(-100, "supergroup")
    await handler(MagicMock(), msg)

    assert await qs.get("") == [-100]


async def test_handler_accepts_group():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(-200, "group")
    await handler(MagicMock(), msg)

    assert await qs.get("") == [-200]


async def test_handler_skips_archived_chat():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService(archived={777})

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(777, "private")
    await handler(MagicMock(), msg)

    assert await qs.get("") == []


async def test_handler_skips_unknown_chat_type():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(99, "channel")  # broadcast channel — skip
    await handler(MagicMock(), msg)

    assert await qs.get("") == []


async def test_handler_broadcasts_queue_update_with_folder_ids():
    """The queue_update event must carry folder_ids so the frontend filter
    can react without extra round-trip.
    """
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()
    # Wire the chat-to-folders map so handler can look it up.
    folder.chat_to_folders = {-100: [2, 3]}  # type: ignore[attr-defined]

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(-100, "supergroup")
    await handler(MagicMock(), msg)

    queue_updates = [
        call.args[0]
        for call in bcast.broadcast.call_args_list
        if call.args[0].get("type") == "queue_update"
    ]
    assert queue_updates
    update = queue_updates[0]
    assert update["chat_id"] == -100
    assert update["account"] == ""
    assert update["folder_ids"] == [2, 3]
