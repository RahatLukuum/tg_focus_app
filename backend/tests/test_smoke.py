"""Smoke test — verifies the app imports and /healthz responds."""
from fastapi.testclient import TestClient


def test_app_imports_and_healthz_returns_ok():
    from main import app

    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_root_returns_metadata():
    from main import app

    client = TestClient(app)
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "TG Backend API"
    assert body["status"] == "ok"
