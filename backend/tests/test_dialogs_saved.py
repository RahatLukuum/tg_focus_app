"""Tests for Saved Messages fallback in /dialogs build."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from routers.dialogs import _build_dialogs_and_queue


def _dialog(chat_id, *, ctype="private", title="X", unread=0, folder_id=0):
    return SimpleNamespace(
        chat=SimpleNamespace(
            id=chat_id, type=SimpleNamespace(value=ctype),
            title=title, first_name=None, last_name=None,
            username=None, is_forum=False,
        ),
        top_message=None,
        unread_messages_count=unread,
        folder_id=folder_id,
    )


class _FakeClient:
    def __init__(self, dialogs, me_id, saved_chat=None):
        self._dialogs = dialogs
        self._me = SimpleNamespace(id=me_id)
        self._saved = saved_chat or SimpleNamespace(
            id=me_id, type=SimpleNamespace(value="private"),
            title="Saved Messages", first_name=None, last_name=None,
            username=None, is_forum=False,
        )

    async def get_dialogs(self, limit=100):
        for d in self._dialogs:
            yield d

    async def get_me(self):
        return self._me

    async def get_chat(self, chat_id):
        if chat_id == self._me.id:
            return self._saved
        raise RuntimeError("not found")


async def test_dialogs_includes_saved_messages_when_pyrogram_omits_it():
    me_id = 555
    dialogs = [_dialog(100, title="Friend"), _dialog(200, title="Group", ctype="group")]
    client = _FakeClient(dialogs=dialogs, me_id=me_id)

    out = await _build_dialogs_and_queue(client, limit=100)

    titles = [d["title"] for d in out["dialogs"]]
    assert "Saved Messages" in titles
    saved = next(d for d in out["dialogs"] if d["chat_id"] == me_id)
    assert saved["type"] == "private"
    assert saved["is_saved_messages"] is True


async def test_dialogs_does_not_duplicate_saved_messages():
    me_id = 555
    dialogs = [
        _dialog(me_id, title="Saved Messages"),
        _dialog(100, title="Friend"),
    ]
    client = _FakeClient(dialogs=dialogs, me_id=me_id)

    out = await _build_dialogs_and_queue(client, limit=100)

    saved_count = sum(1 for d in out["dialogs"] if d["chat_id"] == me_id)
    assert saved_count == 1
