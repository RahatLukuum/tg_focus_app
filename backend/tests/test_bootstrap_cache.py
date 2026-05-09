"""Tests that /bootstrap caches its response per account for ~30s."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.dialogs import make_router
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService


class _FakeAuth:
    def __init__(self):
        self.client = MagicMock()
        self.calls = {"get_dialogs": 0, "get_contacts": 0}

        async def get_dialogs(**kwargs):
            self.calls["get_dialogs"] += 1
            for _ in []:
                yield None

        async def get_contacts():
            self.calls["get_contacts"] += 1
            return []

        async def get_me():
            return SimpleNamespace(id=1, first_name="Me", username=None)

        self.client.get_dialogs = get_dialogs
        self.client.get_contacts = get_contacts
        self.client.get_me = get_me

    async def get_authorized_client(self, account: str = ""):
        return self.client


class _FakeFolderService:
    def __init__(self):
        self._archived: dict[str, set[int]] = {}

    async def get_folders(self, account: str = ""):
        return {"folders": [], "chat_to_folders": {}}

    def set_archived(self, account: str, chat_ids):
        self._archived[account] = set(chat_ids)


def _build_app(auth, folder_svc):
    app = FastAPI()
    manager = MagicMock()
    manager.default = auth.client
    manager.get_or_create = MagicMock(return_value=auth.client)
    manager.ensure_connected = AsyncMock()
    qs = QueueService()
    qmc = QueueMetaCache(ttl_seconds=30)
    app.include_router(make_router(manager, auth, qs, folder_svc, qmc))
    return app


def test_bootstrap_caches_within_ttl():
    auth = _FakeAuth()
    folder = _FakeFolderService()
    client = TestClient(_build_app(auth, folder))

    r1 = client.get("/bootstrap")
    r2 = client.get("/bootstrap")
    r3 = client.get("/bootstrap")
    assert r1.status_code == r2.status_code == r3.status_code == 200
    # Underlying Pyrogram calls happen ONCE
    assert auth.calls["get_dialogs"] == 1
    assert auth.calls["get_contacts"] == 1


def test_bootstrap_cache_keyed_per_account():
    auth = _FakeAuth()
    folder = _FakeFolderService()
    client = TestClient(_build_app(auth, folder))

    client.get("/bootstrap?account=acc1")
    client.get("/bootstrap?account=acc2")
    # Different account → cache miss → second underlying call
    assert auth.calls["get_dialogs"] == 2
