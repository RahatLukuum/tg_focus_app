"""Integration tests for /folders endpoint."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.folders import make_router
from services.folder_service import Folder


class _FakeFolderService:
    def __init__(self, payload: dict | None = None):
        self._payload = payload or {"folders": [], "chat_to_folders": {}}
        self.calls: list[str] = []

    async def get_folders(self, account: str = ""):
        self.calls.append(account)
        return self._payload


def _build_app(svc):
    app = FastAPI()
    app.include_router(make_router(svc))
    return app


def test_returns_empty_payload_when_no_folders():
    svc = _FakeFolderService()
    client = TestClient(_build_app(svc))
    r = client.get("/folders")
    assert r.status_code == 200
    assert r.json() == {"folders": [], "chat_to_folders": {}}


def test_returns_folders_and_map():
    svc = _FakeFolderService(
        {
            "folders": [
                Folder(id=2, title="Work", chat_ids=(100, -200)),
                Folder(id=3, title="Friends", chat_ids=(100,)),
            ],
            "chat_to_folders": {100: [2, 3], -200: [2]},
        }
    )
    client = TestClient(_build_app(svc))
    r = client.get("/folders")
    assert r.status_code == 200
    body = r.json()
    assert body["folders"] == [
        {"id": 2, "title": "Work", "chat_ids": [100, -200]},
        {"id": 3, "title": "Friends", "chat_ids": [100]},
    ]
    # chat_to_folders keys round-trip as strings via JSON; the test must
    # re-parse them for the integer comparison.
    chat_to_folders = {int(k): v for k, v in body["chat_to_folders"].items()}
    assert chat_to_folders == {100: [2, 3], -200: [2]}


def test_passes_account_query_param_through():
    svc = _FakeFolderService()
    client = TestClient(_build_app(svc))
    client.get("/folders?account=%2B71234567890")
    assert svc.calls == ["+71234567890"]
