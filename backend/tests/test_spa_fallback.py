"""Tests for SPA-fallback catch-all behaviour on the FastAPI app."""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_unknown_path_returns_index_html_when_dist_present():
    """If frontend/dist exists with index.html, unknown paths should serve it."""
    import importlib

    import main as main_mod

    dist_dir = main_mod.Path(main_mod.__file__).parent / "frontend" / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    index = dist_dir / "index.html"
    created_index = False
    if not index.exists():
        index.write_text("<html><body>SPA</body></html>", encoding="utf-8")
        created_index = True
    try:
        importlib.reload(main_mod)
        client = TestClient(main_mod.app)
        r = client.get("/chat/12345")
        assert r.status_code == 200
        assert "SPA" in r.text or "<html" in r.text
    finally:
        if created_index:
            try:
                index.unlink()
            except OSError:
                pass


def test_api_path_prefixes_still_404_on_unknown_subpath():
    from main import app

    client = TestClient(app)
    r = client.get("/tasks/this-id-does-not-exist")
    assert r.status_code in (404, 405)


def test_root_path_unaffected():
    from main import app

    client = TestClient(app)
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["service"] == "TG Backend API"


def test_healthz_unaffected():
    from main import app

    client = TestClient(app)
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
