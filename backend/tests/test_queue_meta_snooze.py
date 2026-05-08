"""Tests that /queue?meta=true returns snooze_until per item."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService


class _FakeFolderService:
    async def get_folders(self, account: str = ""):
        return {"folders": [], "chat_to_folders": {}}


@pytest.fixture
def app_factory():
    async def _build(chat_ids: list[int], snoozed: dict[int, int]):
        app = FastAPI()
        qs = QueueService()
        for cid in chat_ids:
            await qs.add("", cid)
        for cid, ts in snoozed.items():
            await qs.snooze("", cid, until_ts=ts)
        manager = MagicMock()
        manager.get_or_create = MagicMock(return_value=MagicMock())
        manager.default = MagicMock()
        manager.ensure_connected = AsyncMock()
        auth = MagicMock()
        auth.get_authorized_client = AsyncMock(return_value=MagicMock())
        app.include_router(
            make_router(
                manager=manager,
                auth=auth,
                queue_service=qs,
                folder_service=_FakeFolderService(),
                topics_service=MagicMock(),
                queue_meta_cache=QueueMetaCache(ttl_seconds=30),
            )
        )
        return app, qs

    return _build


async def test_meta_includes_snooze_until_null_for_active(app_factory):
    app, _ = await app_factory([1, 2], {})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    body = r.json()
    assert body["queue"] == [
        {
            "chat_id": 1,
            "folder_ids": [],
            "snooze_until": None,
            "topic_id": None,
            "topic_title": None,
            "last_message": None,
        },
        {
            "chat_id": 2,
            "folder_ids": [],
            "snooze_until": None,
            "topic_id": None,
            "topic_title": None,
            "last_message": None,
        },
    ]


async def test_meta_excludes_snoozed_chats_from_active_queue(app_factory):
    app, _ = await app_factory([1, 2], {3: 9999999999})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    body = r.json()
    chat_ids = [item["chat_id"] for item in body["queue"]]
    assert 3 not in chat_ids
    assert chat_ids == [1, 2]


async def test_meta_includes_snoozed_section(app_factory):
    """The meta payload must expose snoozed entries so the UI can render them."""
    app, _ = await app_factory([1], {3: 9999999999, 5: 9999999998})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    body = r.json()
    snoozed = {entry["chat_id"]: entry["snooze_until"] for entry in body["snoozed"]}
    assert snoozed == {3: 9999999999, 5: 9999999998}


async def test_default_queue_endpoint_unchanged(app_factory):
    """No meta=true → unchanged shape."""
    app, _ = await app_factory([1], {3: 9999999999})
    client = TestClient(app)
    r = client.get("/queue")
    assert r.json() == {"queue": [1]}
