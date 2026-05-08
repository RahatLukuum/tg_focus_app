"""Unit tests for the pure helpers in routers.dialogs.

We test the mapping/queue logic without spinning up Pyrogram — we feed the
helpers fake dialog objects with the same attribute shape Pyrogram uses.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Iterable

import pytest

from routers.dialogs import _map_dialog, _build_queue_from_dialogs


def _dialog(
    chat_id: int,
    chat_type: str = "private",
    unread: int = 0,
    folder_id: int = 0,
    title: str = "Test Chat",
):
    return SimpleNamespace(
        chat=SimpleNamespace(
            id=chat_id,
            type=SimpleNamespace(value=chat_type),
            title=title,
            username=None,
            first_name=None,
            last_name=None,
        ),
        top_message=None,
        unread_messages_count=unread,
        folder_id=folder_id,
    )


def test_map_dialog_returns_folder_id_zero_for_main():
    out = _map_dialog(_dialog(1, folder_id=0))
    assert out["folder_id"] == 0


def test_map_dialog_returns_folder_id_one_for_archive():
    out = _map_dialog(_dialog(1, folder_id=1))
    assert out["folder_id"] == 1


def test_map_dialog_includes_supergroup_now():
    out = _map_dialog(_dialog(-100, chat_type="supergroup"))
    assert out is not None
    assert out["type"] == "supergroup"


def test_build_queue_includes_groups_with_unread():
    dialogs = [
        _dialog(1, "private", unread=2),
        _dialog(-100, "supergroup", unread=5),
        _dialog(-200, "group", unread=1),
        _dialog(3, "private", unread=0),  # no unread → skip
    ]
    queue = _build_queue_from_dialogs(dialogs)
    assert sorted(queue) == sorted([1, -100, -200])


def test_build_queue_excludes_archive_even_with_unread():
    dialogs = [
        _dialog(1, "private", unread=2, folder_id=0),
        _dialog(2, "private", unread=2, folder_id=1),  # archived → skip
    ]
    queue = _build_queue_from_dialogs(dialogs)
    assert queue == [1]


def test_build_queue_dedupes_chat_ids():
    """Pyrogram should never duplicate a dialog, but be defensive."""
    d = _dialog(1, "private", unread=2)
    queue = _build_queue_from_dialogs([d, d])
    assert queue == [1]
