"""Integration tests for /generate_reply router (Claude mocked, auth mocked)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from anthropic import APIStatusError
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.ai import make_router as make_ai_router


class FakeAuthDeps:
    """Stand-in for AuthDeps that returns a mock Pyrogram client."""

    def __init__(self, history: list):
        self._history = history

    async def get_authorized_client(self, account: str = ""):
        async def gen(*_args, **_kwargs):
            for m in reversed(self._history):
                yield m

        client = MagicMock()
        client.get_chat_history = gen
        return client


def _msg(text: str, *, outgoing: bool = False):
    return SimpleNamespace(text=text, caption=None, outgoing=outgoing)


def _build_app(claude, auth):
    app = FastAPI()
    app.include_router(make_ai_router(claude, auth))
    return app


def test_returns_500_when_claude_not_configured():
    auth = FakeAuthDeps([_msg("hi")])
    app = _build_app(None, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={"chat_id": 1})
    assert r.status_code == 500
    assert "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_returns_400_when_chat_id_missing():
    claude = MagicMock()
    auth = FakeAuthDeps([_msg("hi")])
    app = _build_app(claude, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={})
    assert r.status_code == 400


def test_returns_400_when_no_history():
    claude = MagicMock()
    auth = FakeAuthDeps([])
    app = _build_app(claude, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={"chat_id": 1})
    assert r.status_code == 400
    assert "No messages" in r.json()["detail"]


def test_happy_path_returns_reply():
    claude = MagicMock()
    claude.generate_reply = AsyncMock(return_value="hello back")
    auth = FakeAuthDeps([_msg("hi")])
    app = _build_app(claude, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={"chat_id": 1})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "reply": "hello back"}


def _make_api_status_error(error_type: str, status_code: int) -> APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(
        status_code,
        request=request,
        text=f'{{"error":{{"type":"{error_type}"}}}}',
    )
    return APIStatusError(
        message=error_type,
        response=response,
        body={"error": {"type": error_type}},
    )


def test_rate_limit_maps_to_429():
    claude = MagicMock()
    claude.generate_reply = AsyncMock(
        side_effect=_make_api_status_error("rate_limit_error", 429)
    )
    auth = FakeAuthDeps([_msg("hi")])
    app = _build_app(claude, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={"chat_id": 1})
    assert r.status_code == 429


def test_overloaded_maps_to_503():
    claude = MagicMock()
    claude.generate_reply = AsyncMock(
        side_effect=_make_api_status_error("overloaded_error", 529)
    )
    auth = FakeAuthDeps([_msg("hi")])
    app = _build_app(claude, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={"chat_id": 1})
    assert r.status_code == 503


def test_unexpected_error_maps_to_500_without_leaking_details():
    claude = MagicMock()
    claude.generate_reply = AsyncMock(
        side_effect=ValueError("internal stack secret /etc/passwd")
    )
    auth = FakeAuthDeps([_msg("hi")])
    app = _build_app(claude, auth)
    client = TestClient(app)
    r = client.post("/generate_reply", json={"chat_id": 1})
    assert r.status_code == 500
    body = r.json()
    assert "/etc/passwd" not in body.get("detail", "")
    assert "Internal error" in body.get("detail", "")
