"""Tests for services.task_store.TaskStore."""
from __future__ import annotations

from pathlib import Path

import pytest

from services.state_store import JsonStore
from services.task_store import Task, TaskStore


@pytest.fixture
def store(tmp_state_dir: Path) -> TaskStore:
    json_store: JsonStore = JsonStore(tmp_state_dir / "tasks.json", default_factory=list)
    return TaskStore(json_store)


async def test_list_empty_initially(store: TaskStore):
    assert await store.list() == []


async def test_create_persists_task(store: TaskStore):
    task = await store.create(text="buy milk")
    assert task.text == "buy milk"
    assert task.done is False
    assert task.id  # uuid present
    assert task.created_at > 0
    listed = await store.list()
    assert len(listed) == 1
    assert listed[0].id == task.id


async def test_create_with_chat_attaches_metadata(store: TaskStore):
    task = await store.create(
        text="reply to Ivan",
        chat_id=12345,
        chat_title="Ivan Ivanov",
        account="+71234567890",
    )
    assert task.chat_id == 12345
    assert task.chat_title == "Ivan Ivanov"
    assert task.account == "+71234567890"


async def test_update_marks_done(store: TaskStore):
    task = await store.create(text="x")
    updated = await store.update(task.id, done=True)
    assert updated is not None
    assert updated.done is True
    listed = await store.list()
    assert listed[0].done is True


async def test_update_changes_text(store: TaskStore):
    task = await store.create(text="old")
    updated = await store.update(task.id, text="new")
    assert updated is not None
    assert updated.text == "new"


async def test_update_returns_none_for_missing_id(store: TaskStore):
    assert await store.update("nonexistent", done=True) is None


async def test_delete_removes_task(store: TaskStore):
    task = await store.create(text="x")
    assert await store.delete(task.id) is True
    assert await store.list() == []


async def test_delete_returns_false_for_missing(store: TaskStore):
    assert await store.delete("nonexistent") is False


async def test_clear_completed_removes_only_done(store: TaskStore):
    a = await store.create(text="a")
    b = await store.create(text="b")
    await store.update(a.id, done=True)
    removed = await store.clear_completed()
    assert removed == 1
    listed = await store.list()
    assert len(listed) == 1
    assert listed[0].id == b.id


async def test_list_filters_by_account(store: TaskStore):
    await store.create(text="a", account="acc1")
    await store.create(text="b", account="acc2")
    await store.create(text="c")  # no account
    listed = await store.list(account="acc1")
    assert len(listed) == 1
    assert listed[0].text == "a"


async def test_persistence_across_instances(tmp_state_dir: Path):
    json_store_1: JsonStore = JsonStore(tmp_state_dir / "t.json", default_factory=list)
    s1 = TaskStore(json_store_1)
    await s1.create(text="persist me")

    json_store_2: JsonStore = JsonStore(tmp_state_dir / "t.json", default_factory=list)
    s2 = TaskStore(json_store_2)
    listed = await s2.list()
    assert len(listed) == 1
    assert listed[0].text == "persist me"
