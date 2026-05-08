"""Tests for services.folder_service.FolderService.

The Pyrogram raw API is mocked — tests don't make network calls.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.folder_service import Folder, FolderService


def _filter(id: int, title: str, included_chat_ids: list[int]):
    """Build a fake DialogFilter raw object that FolderService can read.

    Public chat_id convention:
      - positive: user
      - between -1 and -1e12: legacy basic group → raw `chat_id` field
      - <= -1e12: supergroup/channel → raw `channel_id` field (-100 prefix stripped)
    """
    peers = []
    for cid in included_chat_ids:
        if cid > 0:
            peers.append(SimpleNamespace(user_id=cid))
        elif cid <= -1_000_000_000_000:
            # Supergroup/channel: strip -100 prefix → raw channel_id
            channel_id = -cid - 1_000_000_000_000
            peers.append(SimpleNamespace(channel_id=channel_id))
        else:
            # Legacy basic group: raw chat_id is bare positive
            peers.append(SimpleNamespace(chat_id=abs(cid)))
    return SimpleNamespace(
        id=id,
        title=title,
        include_peers=peers,
        exclude_peers=[],
        pinned_peers=[],
    )


def _default_filter():
    """The 'All Chats' pseudo-folder Telegram always returns. We must skip it."""
    return SimpleNamespace(id=0, title=None)  # no `include_peers` attribute


@pytest.fixture
def manager():
    """A mock PyrogramClientManager that returns a connected client per account."""
    mgr = MagicMock()

    async def ensure_connected(_client):
        return None

    mgr.ensure_connected = AsyncMock(side_effect=ensure_connected)

    def get_or_create(account: str):
        # Each account gets its own mock client. The .invoke() side-effect is
        # set per-test via mgr.set_filters_for(account, [...]).
        if account not in mgr._clients:
            client = MagicMock()
            client.invoke = AsyncMock(return_value=[])
            mgr._clients[account] = client
        return mgr._clients[account]

    mgr._clients = {}
    mgr.get_or_create = MagicMock(side_effect=get_or_create)
    mgr.default = MagicMock()
    mgr.default.invoke = AsyncMock(return_value=[])
    return mgr


async def test_get_folders_returns_user_folders_skipping_default(manager):
    svc = FolderService(manager)
    f1 = _filter(2, "Work", [100, -1_001_000_000_200])
    f2 = _filter(3, "Friends", [300])
    manager.default.invoke = AsyncMock(return_value=[_default_filter(), f1, f2])

    out = await svc.get_folders(account="")
    assert [f.id for f in out["folders"]] == [2, 3]
    assert {f.title for f in out["folders"]} == {"Work", "Friends"}


async def test_chat_to_folders_maps_chats_to_their_filter_ids(manager):
    svc = FolderService(manager)
    work = _filter(2, "Work", [100, -1_001_000_000_200])  # 100 user + supergroup
    friends = _filter(3, "Friends", [100, 300])  # 100 in BOTH folders
    manager.default.invoke = AsyncMock(return_value=[_default_filter(), work, friends])

    out = await svc.get_folders(account="")
    chat_to_folders = out["chat_to_folders"]
    assert sorted(chat_to_folders[100]) == [2, 3]
    assert chat_to_folders[-1_001_000_000_200] == [2]
    assert chat_to_folders[300] == [3]


async def test_get_folders_caches_for_60_seconds(manager):
    svc = FolderService(manager, ttl_seconds=60)
    manager.default.invoke = AsyncMock(return_value=[_default_filter()])

    await svc.get_folders(account="")
    await svc.get_folders(account="")
    await svc.get_folders(account="")
    # invoke called only once due to cache
    assert manager.default.invoke.await_count == 1


async def test_get_folders_invalidates_after_ttl(manager):
    svc = FolderService(manager, ttl_seconds=0)  # immediate expiry
    manager.default.invoke = AsyncMock(return_value=[_default_filter()])

    await svc.get_folders(account="")
    await svc.get_folders(account="")
    assert manager.default.invoke.await_count == 2


async def test_invalidate_clears_cache(manager):
    svc = FolderService(manager, ttl_seconds=600)
    manager.default.invoke = AsyncMock(return_value=[_default_filter()])

    await svc.get_folders(account="")
    svc.invalidate(account="")
    await svc.get_folders(account="")
    assert manager.default.invoke.await_count == 2


async def test_per_account_cache_isolation(manager):
    svc = FolderService(manager)
    # Different accounts use different clients; both miss cache initially.
    await svc.get_folders(account="acc1")
    await svc.get_folders(account="acc2")
    await svc.get_folders(account="acc1")  # cached
    await svc.get_folders(account="acc2")  # cached

    # Each account-specific client invoked once.
    c1 = manager._clients["acc1"]
    c2 = manager._clients["acc2"]
    assert c1.invoke.await_count == 1
    assert c2.invoke.await_count == 1


async def test_archive_set_starts_empty(manager):
    svc = FolderService(manager)
    assert svc.is_archived(account="", chat_id=999) is False


async def test_set_archived_marks_chats(manager):
    svc = FolderService(manager)
    svc.set_archived(account="", chat_ids={1, 2, 3})
    assert svc.is_archived(account="", chat_id=1) is True
    assert svc.is_archived(account="", chat_id=2) is True
    assert svc.is_archived(account="", chat_id=99) is False


async def test_set_archived_replaces_previous_set(manager):
    svc = FolderService(manager)
    svc.set_archived(account="", chat_ids={1, 2})
    svc.set_archived(account="", chat_ids={3})
    assert svc.is_archived(account="", chat_id=1) is False
    assert svc.is_archived(account="", chat_id=3) is True


async def test_archive_state_per_account(manager):
    svc = FolderService(manager)
    svc.set_archived(account="acc1", chat_ids={1})
    assert svc.is_archived(account="acc1", chat_id=1) is True
    assert svc.is_archived(account="acc2", chat_id=1) is False


async def test_get_folders_handles_invoke_error(manager):
    """If the raw API throws (e.g., user has no folders configured), return empty."""
    svc = FolderService(manager)
    manager.default.invoke = AsyncMock(side_effect=RuntimeError("boom"))
    out = await svc.get_folders(account="")
    assert out == {"folders": [], "chat_to_folders": {}}


async def test_supergroup_channel_id_uses_minus_100_prefix(manager):
    """Channel peers with raw channel_id=N must map to chat_id=-100N
    matching client.get_dialogs() convention.
    """
    svc = FolderService(manager)
    raw_channel_id = 1234567890
    expected_chat_id = -1_001_234_567_890
    f = SimpleNamespace(
        id=2,
        title="Test",
        include_peers=[SimpleNamespace(channel_id=raw_channel_id)],
    )
    manager.default.invoke = AsyncMock(return_value=[_default_filter(), f])
    out = await svc.get_folders(account="")
    assert expected_chat_id in out["chat_to_folders"]
    folder = out["folders"][0]
    assert folder.chat_ids == (expected_chat_id,)


async def test_legacy_basic_group_chat_id_negated_only(manager):
    """Legacy chat peers with raw chat_id=N must map to -N (no -100 prefix)."""
    svc = FolderService(manager)
    raw_chat_id = 12345
    expected_chat_id = -12345
    f = SimpleNamespace(
        id=2,
        title="Test",
        include_peers=[SimpleNamespace(chat_id=raw_chat_id)],
    )
    manager.default.invoke = AsyncMock(return_value=[_default_filter(), f])
    out = await svc.get_folders(account="")
    assert expected_chat_id in out["chat_to_folders"]
