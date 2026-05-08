"""Integration tests for /queue endpoint (with and without meta=true)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_service import QueueService


class _FakeFolderService:
    def __init__(self, chat_to_folders: dict[int, list[int]] | None = None):
        self._c2f = chat_to_folders or {}

    async def get_folders(self, account: str = ""):
        return {"folders": [], "chat_to_folders": self._c2f}


@pytest.fixture
def app_factory():
    """Builds an app with a queue pre-populated with the given chat_ids."""

    async def _build(chat_ids: list[int], chat_to_folders: dict[int, list[int]]):
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
        folder_svc = _FakeFolderService(chat_to_folders)
        app.include_router(make_router(manager, auth, qs, folder_svc))
        return app, qs

    return _build


async def test_queue_default_returns_chat_ids_only(app_factory):
    app, _ = await app_factory([1, 2, 3], {})
    client = TestClient(app)
    r = client.get("/queue")
    assert r.status_code == 200
    assert r.json() == {"queue": [1, 2, 3]}


async def test_queue_meta_true_returns_objects_with_folder_ids(app_factory):
    app, _ = await app_factory([1, 2], {1: [2, 3], 2: []})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    assert r.status_code == 200
    assert r.json() == {
        "queue": [
            {"chat_id": 1, "folder_ids": [2, 3], "snooze_until": None},
            {"chat_id": 2, "folder_ids": [], "snooze_until": None},
        ],
        "snoozed": [],
    }


async def test_queue_meta_false_explicit_returns_old_shape(app_factory):
    app, _ = await app_factory([5], {5: [9]})
    client = TestClient(app)
    r = client.get("/queue?meta=false")
    assert r.json() == {"queue": [5]}
