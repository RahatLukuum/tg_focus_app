"""Integration tests for /tasks endpoints (assemble app from scratch)."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.tasks import make_router
from services.state_store import JsonStore
from services.task_store import TaskStore


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = FastAPI()
    json_store: JsonStore = JsonStore(tmp_path / "tasks.json", default_factory=list)
    task_store = TaskStore(json_store)
    app.include_router(make_router(task_store))
    return TestClient(app)


def test_get_tasks_empty(client: TestClient):
    r = client.get("/tasks")
    assert r.status_code == 200
    assert r.json() == {"tasks": []}


def test_create_task_returns_payload(client: TestClient):
    r = client.post("/tasks", json={"text": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert body["task"]["text"] == "hello"
    assert body["task"]["done"] is False
    assert body["task"]["id"]


def test_create_then_list(client: TestClient):
    client.post("/tasks", json={"text": "a"})
    client.post("/tasks", json={"text": "b"})
    r = client.get("/tasks")
    assert r.status_code == 200
    tasks = r.json()["tasks"]
    assert len(tasks) == 2
    assert {t["text"] for t in tasks} == {"a", "b"}


def test_create_with_chat_metadata(client: TestClient):
    r = client.post(
        "/tasks",
        json={"text": "reply Ivan", "chat_id": 999, "chat_title": "Ivan"},
    )
    body = r.json()["task"]
    assert body["chat_id"] == 999
    assert body["chat_title"] == "Ivan"


def test_create_rejects_empty_text(client: TestClient):
    r = client.post("/tasks", json={"text": ""})
    assert r.status_code == 400


def test_patch_marks_done(client: TestClient):
    created = client.post("/tasks", json={"text": "x"}).json()["task"]
    r = client.patch(f"/tasks/{created['id']}", json={"done": True})
    assert r.status_code == 200
    assert r.json()["task"]["done"] is True


def test_patch_404_for_unknown_id(client: TestClient):
    r = client.patch("/tasks/missing", json={"done": True})
    assert r.status_code == 404


def test_delete_task(client: TestClient):
    created = client.post("/tasks", json={"text": "x"}).json()["task"]
    r = client.delete(f"/tasks/{created['id']}")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert client.get("/tasks").json()["tasks"] == []


def test_delete_404_for_unknown(client: TestClient):
    r = client.delete("/tasks/missing")
    assert r.status_code == 404


def test_clear_completed(client: TestClient):
    a = client.post("/tasks", json={"text": "a"}).json()["task"]
    client.post("/tasks", json={"text": "b"})
    client.patch(f"/tasks/{a['id']}", json={"done": True})
    r = client.delete("/tasks/completed")
    assert r.status_code == 200
    assert r.json()["removed"] == 1
    remaining = client.get("/tasks").json()["tasks"]
    assert len(remaining) == 1
    assert remaining[0]["text"] == "b"


def test_account_filter(client: TestClient):
    client.post("/tasks", json={"text": "a", "account": "+71234567890"})
    client.post("/tasks", json={"text": "b", "account": "+79876543210"})
    r = client.get("/tasks", params={"account": "+71234567890"})
    assert [t["text"] for t in r.json()["tasks"]] == ["a"]


def test_completed_route_takes_precedence_over_path_param(client: TestClient):
    """/tasks/completed must be matched as a literal route, not as task_id='completed'.

    Regression test: route registration order matters here.
    """
    # Create a task with id 'completed' would be ideal but ids are server-generated UUIDs.
    # Instead verify that DELETE /tasks/completed returns the clear-completed shape, not a 404.
    a = client.post("/tasks", json={"text": "a"}).json()["task"]
    client.patch(f"/tasks/{a['id']}", json={"done": True})
    r = client.delete("/tasks/completed")
    assert r.status_code == 200
    body = r.json()
    assert "removed" in body  # clear-completed response shape
    assert body["removed"] == 1
    # Also verify it doesn't return the per-task delete shape `{"ok": True}` only
    assert body.get("removed") is not None
