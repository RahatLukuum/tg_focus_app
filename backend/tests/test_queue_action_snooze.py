"""Integration tests for /queue/action with action='snooze'."""
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
    async def _build(chat_ids: list[int]):
        app = FastAPI()
        qs = QueueService()
        for cid in chat_ids:
            await qs.add("", cid)
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


async def test_snooze_action_removes_from_queue(app_factory):
    app, qs = await app_factory([1, 2, 3])
    client = TestClient(app)
    r = client.post(
        "/queue/action",
        json={"chat_id": 1, "action": "snooze", "snooze_until": 9999999999},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert 1 not in body["queue"]
    assert await qs.snoozed("") == {1: 9999999999}


async def test_snooze_rejects_past_timestamp(app_factory):
    app, qs = await app_factory([1])
    client = TestClient(app)
    r = client.post(
        "/queue/action",
        json={"chat_id": 1, "action": "snooze", "snooze_until": 1},
    )
    assert r.status_code == 400


async def test_snooze_requires_until_ts(app_factory):
    app, qs = await app_factory([1])
    client = TestClient(app)
    r = client.post("/queue/action", json={"chat_id": 1, "action": "snooze"})
    assert r.status_code == 400
