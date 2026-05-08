"""Tests for extract_media_info covering video_note, audio, document metadata."""
from __future__ import annotations

from types import SimpleNamespace

from services.media_utils import extract_media_info


def _msg(**kw):
    base = dict(
        photo=None, video=None, voice=None, video_note=None,
        document=None, audio=None,
        chat=SimpleNamespace(id=42), id=7,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_video_note_returns_distinct_type():
    m = _msg(video_note=SimpleNamespace(duration=8))
    info = extract_media_info(m)
    assert info["media_type"] == "video_note"
    assert info["duration"] == 8


def test_audio_returns_audio_type_with_filename_and_duration():
    m = _msg(audio=SimpleNamespace(duration=180, file_name="podcast.mp3"))
    info = extract_media_info(m)
    assert info["media_type"] == "audio"
    assert info["duration"] == 180
    assert info["file_name"] == "podcast.mp3"


def test_document_returns_size_and_mime():
    m = _msg(document=SimpleNamespace(
        file_name="report.pdf", file_size=2048, mime_type="application/pdf",
    ))
    info = extract_media_info(m)
    assert info["media_type"] == "document"
    assert info["file_name"] == "report.pdf"
    assert info["file_size"] == 2048
    assert info["mime_type"] == "application/pdf"


def test_audio_takes_precedence_over_document():
    m = _msg(
        audio=SimpleNamespace(duration=10, file_name="a.mp3"),
        document=SimpleNamespace(file_name="x", file_size=1, mime_type="audio/mpeg"),
    )
    info = extract_media_info(m)
    assert info["media_type"] == "audio"


def test_no_media_returns_empty():
    m = _msg()
    assert extract_media_info(m) == {}


def test_chat_id_override_used_in_url():
    m = _msg(photo=SimpleNamespace())
    info = extract_media_info(m, chat_id=-100123)
    assert info["media_url"] == "/media/-100123/7"
