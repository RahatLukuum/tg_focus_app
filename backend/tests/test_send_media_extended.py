"""Tests for /send_media: video_note, audio, message_thread_id."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


class _Auth:
    def __init__(self, client): self._client = client
    async def get_authorized_client(self, account): return self._client


class _Manager:
    def __init__(self, client):
        self._client = client; self.default = client
    def get_or_create(self, account): return self._client
    async def ensure_connected(self, c): return None


def _client_with_capture():
    captured = {"calls": []}
    client = MagicMock()
    client.me = SimpleNamespace(id=1)

    async def fake_get_me(): return client.me
    client.get_me = fake_get_me

    async def send_video_note(**kw):
        captured["calls"].append(("send_video_note", kw)); return SimpleNamespace(id=999)
    async def send_audio(**kw):
        captured["calls"].append(("send_audio", kw)); return SimpleNamespace(id=999)
    async def send_photo(**kw):
        captured["calls"].append(("send_photo", kw)); return SimpleNamespace(id=999)
    async def send_video(**kw):
        captured["calls"].append(("send_video", kw)); return SimpleNamespace(id=999)
    async def send_voice(**kw):
        captured["calls"].append(("send_voice", kw)); return SimpleNamespace(id=999)
    async def send_document(**kw):
        captured["calls"].append(("send_document", kw)); return SimpleNamespace(id=999)

    client.send_video_note = send_video_note
    client.send_audio = send_audio
    client.send_photo = send_photo
    client.send_video = send_video
    client.send_voice = send_voice
    client.send_document = send_document
    return client, captured


def _api(client):
    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    return TestClient(app)


def test_send_media_video_note_strips_caption():
    client, cap = _client_with_capture()
    api = _api(client)
    r = api.post("/send_media", data={
        "chat_id": "-100123", "media_type": "video_note", "caption": "ignored",
    }, files={"file": ("clip.mp4", b"binary", "video/mp4")})
    assert r.status_code == 200
    assert cap["calls"][0][0] == "send_video_note"
    kw = cap["calls"][0][1]
    assert "caption" not in kw or kw["caption"] is None


def test_send_media_audio_passes_caption_and_filename():
    client, cap = _client_with_capture()
    api = _api(client)
    r = api.post("/send_media", data={
        "chat_id": "-100123", "media_type": "audio", "caption": "track",
    }, files={"file": ("song.mp3", b"binary", "audio/mpeg")})
    assert r.status_code == 200
    assert cap["calls"][0][0] == "send_audio"
    kw = cap["calls"][0][1]
    assert kw["caption"] == "track"


def test_send_media_passes_message_thread_id():
    client, cap = _client_with_capture()
    api = _api(client)
    r = api.post("/send_media", data={
        "chat_id": "-100123", "media_type": "photo", "caption": "",
        "message_thread_id": "7",
    }, files={"file": ("p.jpg", b"binary", "image/jpeg")})
    assert r.status_code == 200
    kw = cap["calls"][0][1]
    assert kw.get("message_thread_id") == 7
