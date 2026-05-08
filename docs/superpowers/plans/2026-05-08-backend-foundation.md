# Backend Foundation Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 1114-line `backend/main.py` into focused modules, add persistent task storage with `/tasks` API, and migrate `/generate_reply` to the official Anthropic SDK with Haiku 4.5 + prompt caching + retry.

**Architecture:** Keep FastAPI + Pyrogram + multi-account in-memory clients. Extract responsibilities into routers and services per `coding-style.md` (≤400 LOC files). Add a generic `JsonStore` for atomic file persistence. New `/tasks` endpoint replaces the localStorage-only TodoPage. Claude calls move from raw `httpx` to `AsyncAnthropic` with `cache_control` on system prompt and SDK auto-retry (3×).

**Tech Stack:** Python 3.11, FastAPI 0.115, Pyrogram 2.0, anthropic≥0.40, pytest + pytest-asyncio + httpx (TestClient). React 18 + TypeScript on the frontend (only TodoPage touched).

**Spec:** `docs/superpowers/specs/2026-05-08-tg-focus-app-redesign-design.md` — covers Phases 1, 2, 8.

**Out of scope (future plans):**
- Plan 2: Folders + queue extension to non-private chats + WS payload (Phases 3, 4 partial)
- Plan 3: SPA-fallback + message cache + prefetch (Phase 5)
- Plan 4: Snooze + 4-button QueuePage + chip filters + frontend decomposition (Phases 6, 7, remainder of 4)

---

## File Structure (Plan 1)

### Backend — new files

| File | Responsibility | Source of code |
|---|---|---|
| `backend/config.py` | `AppConfig` (frozen dataclass) loaded from env | `decouple` calls in current main.py:30-61 |
| `backend/deps/__init__.py` | empty | — |
| `backend/deps/pyrogram_clients.py` | `clients` dict + `get_or_create_client` + `attach_incoming_handler` + ensure_connected helpers | main.py:67, 274-365 |
| `backend/deps/auth.py` | `get_authorized_client` dependency | main.py:368-380 |
| `backend/services/__init__.py` | empty | — |
| `backend/services/state_store.py` | generic `JsonStore[T]` with atomic write + asyncio.Lock | NEW |
| `backend/services/task_store.py` | `Task` dataclass + `TaskStore` (CRUD over JsonStore) | NEW |
| `backend/services/queue_service.py` | `QueueService` wrapping the 6 queue helpers | main.py:78-145 (in-memory only this phase, persist in Plan 4) |
| `backend/services/media_utils.py` | `extract_media_info` | main.py:162-189 + duplicated logic main.py:619-664 |
| `backend/services/claude_client.py` | `ClaudeConfig` + `ClaudeClient` (AsyncAnthropic wrapper) | main.py:1051-1111 reworked |
| `backend/ws/__init__.py` | empty | — |
| `backend/ws/broadcaster.py` | `connected_clients` set + `broadcast` function | main.py:68, 148-159 |
| `backend/handlers/__init__.py` | empty | — |
| `backend/handlers/incoming.py` | `incoming_handler` factory (private chats only this phase, broadened in Plan 2) | main.py:192-235, 296-341 |
| `backend/routers/__init__.py` | empty | — |
| `backend/routers/auth.py` | `/auth/send_code`, `/auth/sign_in`, `/me` | main.py:449-532 |
| `backend/routers/dialogs.py` | `/dialogs`, `/contacts`, `/chat_info`, `/bootstrap`, `/resolve_contact` | main.py:537-706, 947-1046 |
| `backend/routers/messages.py` | `/messages`, `/send_message`, `/media/*`, `/send_media` | main.py:599-841 |
| `backend/routers/queue.py` | `/queue`, `/queue/action` | main.py:866-942 |
| `backend/routers/tasks.py` | `/tasks` CRUD | NEW |
| `backend/routers/ai.py` | `/generate_reply` | main.py:1053-1111 reworked |
| `backend/tests/__init__.py` | empty | — |
| `backend/tests/conftest.py` | pytest fixtures (tmp_path JsonStore, AsyncClient) | NEW |
| `backend/tests/test_state_store.py` | tests for JsonStore | NEW |
| `backend/tests/test_task_store.py` | tests for TaskStore | NEW |
| `backend/tests/test_tasks_api.py` | integration tests for /tasks | NEW |
| `backend/tests/test_claude_client.py` | tests for ClaudeClient (mocked SDK) | NEW |
| `backend/tests/test_smoke.py` | smoke test that imports app and hits /healthz | NEW |
| `backend/pytest.ini` | pytest config (asyncio_mode, paths) | NEW |

### Backend — modified files

| File | Change |
|---|---|
| `backend/main.py` | Slim entrypoint: `FastAPI()` + middleware + include_router for each router + lifespan (≤80 LOC) |
| `backend/requirements.txt` | Add `anthropic>=0.40.0`, `pytest>=8.0`, `pytest-asyncio>=0.23`, `python-dotenv>=1.0` (dev) |

### Frontend — modified files

| File | Change |
|---|---|
| `frontend/src/services/tasksApi.ts` | NEW — HTTP client for `/tasks` |
| `frontend/src/pages/TodoPage.tsx` | Switch from localStorage to `/tasks` API + one-time migration of localStorage entries |

---

## Conventions used by every task

- **Working directory:** `/Users/den1shh/Documents/growfood/tg_focus_app/backend` for backend tasks unless noted.
- **Run tests:** `source .venv/bin/activate && pytest backend/tests/ -v` from repo root.
- **Run smoke (manual):** `source backend/.venv/bin/activate && uvicorn backend.main:app --port 8080` and hit `curl http://localhost:8080/healthz` → `{"ok": true}`.
- **Commit format:** Conventional Commits (`feat:`, `refactor:`, `test:`, `chore:`).
- **Branch:** `denis-branch` (current).

---

## Phase A — Test infrastructure & smoke baseline

### Task 1: Add test dependencies and pytest config

**Files:**
- Modify: `backend/requirements.txt`
- Create: `backend/pytest.ini`
- Create: `backend/tests/__init__.py` (empty)

- [ ] **Step 1: Update `backend/requirements.txt`**

Append to the file:

```
anthropic>=0.40.0
pytest>=8.0
pytest-asyncio>=0.23
```

Final file:
```
pyrogram==2.0.106
python-decouple==3.8
fastapi==0.115.0
uvicorn[standard]==0.30.6
tgcrypto==1.2.5
httpx==0.27.0
python-multipart==0.0.9
anthropic>=0.40.0
pytest>=8.0
pytest-asyncio>=0.23
```

- [ ] **Step 2: Create `backend/pytest.ini`**

```ini
[pytest]
asyncio_mode = auto
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
```

- [ ] **Step 3: Create empty `backend/tests/__init__.py`**

```python
```

(Empty file. Use `:>` or `touch backend/tests/__init__.py`.)

- [ ] **Step 4: Install dependencies**

Run from repo root:
```bash
cd backend && source .venv/bin/activate && pip install -r requirements.txt
```
Expected: anthropic, pytest, pytest-asyncio install successfully.

- [ ] **Step 5: Verify pytest discovers nothing yet (sanity)**

Run from `backend/`:
```bash
pytest -v
```
Expected: `no tests ran in 0.0X s`. Exit code 5 (no tests collected) is acceptable.

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/pytest.ini backend/tests/__init__.py
git commit -m "chore: add pytest infrastructure and anthropic SDK dependency"
```

---

### Task 2: Add smoke test for /healthz before any refactoring

**Files:**
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_smoke.py`

- [ ] **Step 1: Write `backend/tests/conftest.py`**

```python
"""Shared pytest fixtures for backend tests."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

# Set required env vars BEFORE main.py is imported, so decouple.config() succeeds.
os.environ.setdefault("API_ID", "12345")
os.environ.setdefault("API_HASH", "test_api_hash_for_unit_tests_only")
os.environ.setdefault("LOGIN", "test_session")
os.environ.setdefault("SESSION_DIR", str(Path(__file__).parent / "_session_tmp"))
Path(os.environ["SESSION_DIR"]).mkdir(parents=True, exist_ok=True)


@pytest.fixture
def tmp_state_dir(tmp_path: Path) -> Path:
    d = tmp_path / "state"
    d.mkdir()
    return d
```

- [ ] **Step 2: Write `backend/tests/test_smoke.py`**

```python
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
```

- [ ] **Step 3: Run tests**

From `backend/`:
```bash
pytest tests/test_smoke.py -v
```
Expected: 2 tests pass. If imports fail because of missing env vars, double-check `conftest.py` ran first.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/conftest.py backend/tests/test_smoke.py
git commit -m "test: add smoke test for app import and /healthz"
```

---

## Phase B — Add new modules WITHOUT touching main.py yet

We add the new code first (state_store, task_store, claude_client, tasks router) with full TDD. Decomposition of `main.py` happens later in Phase C.

### Task 3: state_store.py — atomic JSON persistence (TDD)

**Files:**
- Create: `backend/services/__init__.py`
- Create: `backend/services/state_store.py`
- Create: `backend/tests/test_state_store.py`

- [ ] **Step 1: Create empty `backend/services/__init__.py`**

```python
```

- [ ] **Step 2: Write failing tests `backend/tests/test_state_store.py`**

```python
"""Tests for services.state_store.JsonStore."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from services.state_store import JsonStore


@pytest.fixture
def store(tmp_state_dir: Path) -> JsonStore:
    return JsonStore(tmp_state_dir / "data.json", default_factory=list)


async def test_load_returns_default_when_file_missing(store: JsonStore):
    assert await store.load() == []


async def test_save_then_load_roundtrip(store: JsonStore):
    await store.save([{"id": "1", "value": "hello"}])
    assert await store.load() == [{"id": "1", "value": "hello"}]


async def test_update_applies_mutator_atomically(store: JsonStore):
    await store.save([{"id": "1"}])
    new_data = await store.update(lambda data: data + [{"id": "2"}])
    assert new_data == [{"id": "1"}, {"id": "2"}]
    assert await store.load() == [{"id": "1"}, {"id": "2"}]


async def test_corrupted_json_returns_default(store: JsonStore, tmp_state_dir: Path):
    (tmp_state_dir / "data.json").write_text("not valid json {{{")
    # On corrupted file we fall back to default and rename the file aside.
    assert await store.load() == []


async def test_concurrent_updates_serialize(tmp_state_dir: Path):
    store = JsonStore(tmp_state_dir / "counter.json", default_factory=lambda: {"n": 0})

    async def increment(by: int):
        await store.update(lambda d: {"n": d["n"] + by})

    await asyncio.gather(*(increment(1) for _ in range(20)))
    assert (await store.load())["n"] == 20


async def test_atomic_write_no_partial_file(store: JsonStore, tmp_state_dir: Path):
    """If save raises mid-write, the original file must remain intact."""
    await store.save([{"id": "original"}])

    class Boom(Exception):
        pass

    # Monkey-patch json.dump to fail after writing some bytes.
    real_dump = json.dump
    call_count = {"n": 0}

    def flaky_dump(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise Boom("simulated mid-write failure")
        return real_dump(*args, **kwargs)

    import services.state_store as m

    m.json.dump = flaky_dump  # type: ignore
    try:
        with pytest.raises(Boom):
            await store.save([{"id": "new"}])
    finally:
        m.json.dump = real_dump  # type: ignore

    # Original content preserved.
    assert await store.load() == [{"id": "original"}]
```

- [ ] **Step 3: Run tests, verify they fail**

From `backend/`:
```bash
pytest tests/test_state_store.py -v
```
Expected: ImportError or ModuleNotFoundError on `services.state_store`.

- [ ] **Step 4: Implement `backend/services/state_store.py`**

```python
"""Generic atomic-write JSON persistence with asyncio locking.

Designed for small (<1MB) state files like task lists and queue snapshots.
Not optimized for large blobs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import time
from pathlib import Path
from typing import Callable, Generic, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


class JsonStore(Generic[T]):
    """Atomic JSON persistence backed by a single file.

    All public methods are coroutines and use one asyncio.Lock per instance.
    Write strategy: serialize to a sibling .tmp file, fsync, rename over the
    target. This survives kill -9 mid-write — readers see either the old or
    the new content, never partial.
    """

    def __init__(
        self,
        path: Path,
        default_factory: Callable[[], T],
    ) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._default_factory = default_factory
        self._path.parent.mkdir(parents=True, exist_ok=True)

    async def load(self) -> T:
        async with self._lock:
            return self._load_unlocked()

    async def save(self, data: T) -> None:
        async with self._lock:
            self._save_unlocked(data)

    async def update(self, mutator: Callable[[T], T]) -> T:
        """Read-modify-write under a single lock acquisition."""
        async with self._lock:
            current = self._load_unlocked()
            new_data = mutator(current)
            self._save_unlocked(new_data)
            return new_data

    def _load_unlocked(self) -> T:
        if not self._path.exists():
            return self._default_factory()
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.error(
                "State file %s corrupted (%s) — using default and aside-renaming",
                self._path,
                e,
            )
            self._move_aside_corrupted()
            return self._default_factory()

    def _save_unlocked(self, data: T) -> None:
        tmp = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=self._path.parent,
            delete=False,
            suffix=".tmp",
        )
        tmp_path = Path(tmp.name)
        try:
            json.dump(data, tmp, ensure_ascii=False, indent=2, sort_keys=True)
            tmp.flush()
            try:
                import os as _os

                _os.fsync(tmp.fileno())
            except OSError:
                pass
            tmp.close()
            tmp_path.replace(self._path)
        except Exception:
            tmp.close()
            tmp_path.unlink(missing_ok=True)
            raise

    def _move_aside_corrupted(self) -> None:
        try:
            target = self._path.with_suffix(
                self._path.suffix + f".corrupted-{int(time.time())}"
            )
            self._path.rename(target)
            logger.warning("Renamed corrupted state to %s", target)
        except OSError:
            pass
```

- [ ] **Step 5: Run tests, verify pass**

```bash
pytest tests/test_state_store.py -v
```
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/services/__init__.py backend/services/state_store.py backend/tests/test_state_store.py
git commit -m "feat(state): add JsonStore with atomic write and asyncio locking"
```

---

### Task 4: task_store.py — Task model + TaskStore (TDD)

**Files:**
- Create: `backend/services/task_store.py`
- Create: `backend/tests/test_task_store.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_task_store.py`**

```python
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pytest tests/test_task_store.py -v
```
Expected: ModuleNotFoundError on `services.task_store`.

- [ ] **Step 3: Implement `backend/services/task_store.py`**

```python
"""Task storage backed by JsonStore — persistent CRUD for TodoPage."""
from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Optional

from services.state_store import JsonStore


@dataclass(frozen=True)
class Task:
    id: str
    text: str
    done: bool
    created_at: int
    chat_id: Optional[int] = None
    chat_title: Optional[str] = None
    account: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Task":
        return cls(
            id=d["id"],
            text=d["text"],
            done=bool(d["done"]),
            created_at=int(d["created_at"]),
            chat_id=d.get("chat_id"),
            chat_title=d.get("chat_title"),
            account=d.get("account"),
        )


class TaskStore:
    """CRUD over a list-of-Task JsonStore."""

    def __init__(self, store: JsonStore) -> None:
        self._store = store

    async def list(self, account: str = "") -> list[Task]:
        data = await self._store.load()
        tasks = [Task.from_dict(d) for d in data]
        if account:
            tasks = [t for t in tasks if t.account == account]
        return tasks

    async def create(
        self,
        text: str,
        *,
        chat_id: Optional[int] = None,
        chat_title: Optional[str] = None,
        account: str = "",
    ) -> Task:
        task = Task(
            id=str(uuid.uuid4()),
            text=text,
            done=False,
            created_at=int(time.time()),
            chat_id=chat_id,
            chat_title=chat_title,
            account=account or None,
        )
        await self._store.update(lambda data: data + [task.to_dict()])
        return task

    async def update(
        self,
        task_id: str,
        *,
        done: Optional[bool] = None,
        text: Optional[str] = None,
    ) -> Optional[Task]:
        if done is None and text is None:
            return await self._get(task_id)

        found: list[Optional[Task]] = [None]

        def mutator(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
            new_data: list[dict[str, Any]] = []
            for d in data:
                if d["id"] == task_id:
                    if done is not None:
                        d = {**d, "done": bool(done)}
                    if text is not None:
                        d = {**d, "text": text}
                    found[0] = Task.from_dict(d)
                new_data.append(d)
            return new_data

        await self._store.update(mutator)
        return found[0]

    async def delete(self, task_id: str) -> bool:
        deleted = [False]

        def mutator(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
            kept = [d for d in data if d["id"] != task_id]
            if len(kept) != len(data):
                deleted[0] = True
            return kept

        await self._store.update(mutator)
        return deleted[0]

    async def clear_completed(self, account: str = "") -> int:
        removed = [0]

        def mutator(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
            kept: list[dict[str, Any]] = []
            for d in data:
                if d["done"] and (not account or d.get("account") == account):
                    removed[0] += 1
                    continue
                kept.append(d)
            return kept

        await self._store.update(mutator)
        return removed[0]

    async def _get(self, task_id: str) -> Optional[Task]:
        for t in await self.list():
            if t.id == task_id:
                return t
        return None
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_task_store.py -v
```
Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/task_store.py backend/tests/test_task_store.py
git commit -m "feat(tasks): add Task dataclass and TaskStore CRUD over JsonStore"
```

---

### Task 5: claude_client.py — AsyncAnthropic wrapper (TDD)

**Files:**
- Create: `backend/services/claude_client.py`
- Create: `backend/tests/test_claude_client.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_claude_client.py`**

```python
"""Tests for services.claude_client.ClaudeClient (mocked Anthropic SDK)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.claude_client import ClaudeClient, ClaudeConfig, DEFAULT_SYSTEM_PROMPT


def make_response(text: str):
    block = SimpleNamespace(type="text", text=text)
    return SimpleNamespace(content=[block])


@pytest.fixture
def cfg() -> ClaudeConfig:
    return ClaudeConfig(api_key="sk-test", model="claude-haiku-4-5", max_tokens=512)


async def test_generate_reply_returns_concatenated_text(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("hello world"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    history = [{"role": "user", "content": "hi"}]
    reply = await client.generate_reply(history)
    assert reply == "hello world"


async def test_generate_reply_applies_default_system_prompt(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("ok"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    await client.generate_reply([{"role": "user", "content": "hi"}])

    call_kwargs = mock_create.call_args.kwargs
    assert call_kwargs["model"] == "claude-haiku-4-5"
    assert call_kwargs["max_tokens"] == 512
    system_blocks = call_kwargs["system"]
    assert isinstance(system_blocks, list)
    assert system_blocks[0]["text"] == DEFAULT_SYSTEM_PROMPT
    assert system_blocks[0]["cache_control"] == {"type": "ephemeral"}


async def test_generate_reply_custom_system_prompt(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("ok"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    await client.generate_reply(
        [{"role": "user", "content": "hi"}],
        system_prompt="be a pirate",
    )
    assert mock_create.call_args.kwargs["system"][0]["text"] == "be a pirate"


async def test_generate_reply_concatenates_multiple_text_blocks(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text="part one"),
            SimpleNamespace(type="text", text="part two"),
        ]
    )
    mock_create = AsyncMock(return_value=response)
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    reply = await client.generate_reply([{"role": "user", "content": "hi"}])
    assert reply == "part one\npart two"


async def test_generate_reply_strips_whitespace(cfg: ClaudeConfig):
    client = ClaudeClient(cfg)
    mock_create = AsyncMock(return_value=make_response("  spaced  \n"))
    client._client = MagicMock()
    client._client.messages = MagicMock()
    client._client.messages.create = mock_create

    reply = await client.generate_reply([{"role": "user", "content": "hi"}])
    assert reply == "spaced"


async def test_constructor_uses_max_retries_3():
    """We trust the SDK auto-retry — verify config is forwarded."""
    cfg = ClaudeConfig(api_key="sk-x")
    client = ClaudeClient(cfg)
    # AsyncAnthropic stores max_retries on the underlying client.
    assert client._client.max_retries == 3
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pytest tests/test_claude_client.py -v
```
Expected: ModuleNotFoundError on `services.claude_client`.

- [ ] **Step 3: Implement `backend/services/claude_client.py`**

```python
"""Anthropic Claude API client — Haiku 4.5 + prompt caching + auto-retry."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from anthropic import AsyncAnthropic

logger = logging.getLogger(__name__)


DEFAULT_SYSTEM_PROMPT = (
    "Ты — помощник пользователя в Telegram-переписке. "
    "Сгенерируй подходящий ответ на последнее сообщение собеседника. "
    "Пиши кратко и по делу. Отвечай на том же языке, что и собеседник."
)


@dataclass(frozen=True)
class ClaudeConfig:
    api_key: str
    model: str = "claude-haiku-4-5"
    max_tokens: int = 1024


class ClaudeClient:
    """Thin wrapper over AsyncAnthropic with system caching baked in.

    SDK auto-retries on 429/5xx with exponential backoff (max_retries=3).
    Callers should catch anthropic.APIStatusError to map to HTTP errors.
    """

    def __init__(self, cfg: ClaudeConfig) -> None:
        self._cfg = cfg
        self._client = AsyncAnthropic(api_key=cfg.api_key, max_retries=3)

    async def generate_reply(
        self,
        history: list[dict],
        system_prompt: Optional[str] = None,
    ) -> str:
        sys_text = system_prompt or DEFAULT_SYSTEM_PROMPT
        resp = await self._client.messages.create(
            model=self._cfg.model,
            max_tokens=self._cfg.max_tokens,
            system=[
                {
                    "type": "text",
                    "text": sys_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=history,
        )
        text_blocks = [b.text for b in resp.content if b.type == "text"]
        return "\n".join(text_blocks).strip()
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_claude_client.py -v
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/claude_client.py backend/tests/test_claude_client.py
git commit -m "feat(ai): add ClaudeClient wrapper with Haiku 4.5 + caching + auto-retry"
```

---

## Phase C — Decompose main.py incrementally

We move existing code into modules **without changing behavior**. After each task, the smoke test must still pass.

### Task 6: Extract config.py

**Files:**
- Create: `backend/config.py`
- Modify: `backend/main.py:30-61` (replace inline config loading with import)

- [ ] **Step 1: Create `backend/config.py`**

```python
"""Application configuration loaded from environment via python-decouple."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from decouple import config


@dataclass(frozen=True)
class ProxyConfig:
    scheme: str
    hostname: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None

    def to_pyrogram_dict(self) -> dict:
        d: dict = {
            "scheme": self.scheme,
            "hostname": self.hostname,
            "port": self.port,
        }
        if self.username:
            d["username"] = self.username
        if self.password:
            d["password"] = self.password
        return d


@dataclass(frozen=True)
class AppConfig:
    api_id: int
    api_hash: str
    login: str
    session_dir: Path
    anthropic_api_key: str
    proxy: Optional[ProxyConfig]


def load_config() -> AppConfig:
    api_id = int(config("API_ID"))
    api_hash = config("API_HASH")
    login = config("LOGIN")
    default_session_dir = str((Path(__file__).parent / "sessions").resolve())
    session_dir = Path(config("SESSION_DIR", default=default_session_dir))
    session_dir.mkdir(parents=True, exist_ok=True)

    proxy = _load_proxy()
    anthropic_api_key = config("ANTHROPIC_API_KEY", default="")

    return AppConfig(
        api_id=api_id,
        api_hash=api_hash,
        login=login,
        session_dir=session_dir,
        anthropic_api_key=anthropic_api_key,
        proxy=proxy,
    )


def _load_proxy() -> Optional[ProxyConfig]:
    host = config("PROXY_HOST", default=None)
    port = config("PROXY_PORT", default=None)
    if not host or not port:
        return None
    try:
        return ProxyConfig(
            scheme=config("PROXY_SCHEME", default="socks5"),
            hostname=host,
            port=int(port),
            username=config("PROXY_USERNAME", default=None),
            password=config("PROXY_PASSWORD", default=None),
        )
    except (ValueError, TypeError):
        return None
```

- [ ] **Step 2: Run smoke test**

```bash
cd backend && pytest tests/test_smoke.py -v
```
Expected: 2 tests still pass (config.py is unused yet but importable).

- [ ] **Step 3: Commit**

```bash
git add backend/config.py
git commit -m "refactor(config): extract AppConfig + load_config from main.py"
```

---

### Task 7: Extract media_utils.py

**Files:**
- Create: `backend/services/media_utils.py`

- [ ] **Step 1: Create `backend/services/media_utils.py`**

```python
"""Media metadata extraction shared between message handler and history endpoint."""
from __future__ import annotations

from typing import Any, Optional

from pyrogram.types import Message


def extract_media_info(message: Message, *, chat_id: Optional[int] = None) -> dict[str, Any]:
    """Return media_type/media_url/file_name/duration if present, else empty dict.

    chat_id can be passed to override message.chat.id (used by handler that wants
    the chat that delivered the message even on forwards).
    """
    media_type: Optional[str] = None
    file_name: Optional[str] = None
    duration: Optional[int] = None

    if message.photo:
        media_type = "photo"
    elif message.video:
        media_type = "video"
        duration = getattr(message.video, "duration", None)
        file_name = getattr(message.video, "file_name", None)
    elif message.voice:
        media_type = "voice"
        duration = getattr(message.voice, "duration", None)
    elif message.video_note:
        media_type = "video"
        duration = getattr(message.video_note, "duration", None)
    elif message.document:
        media_type = "document"
        file_name = getattr(message.document, "file_name", None)

    if not media_type:
        return {}

    cid = chat_id if chat_id is not None else message.chat.id
    result: dict[str, Any] = {
        "media_type": media_type,
        "media_url": f"/media/{cid}/{message.id}",
    }
    if file_name:
        result["file_name"] = file_name
    if duration is not None:
        result["duration"] = duration
    return result
```

- [ ] **Step 2: Run smoke test**

```bash
pytest tests/test_smoke.py -v
```
Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add backend/services/media_utils.py
git commit -m "refactor(media): extract extract_media_info to services/media_utils.py"
```

---

### Task 8: Extract ws/broadcaster.py

**Files:**
- Create: `backend/ws/__init__.py`
- Create: `backend/ws/broadcaster.py`

- [ ] **Step 1: Create empty `backend/ws/__init__.py`**

```python
```

- [ ] **Step 2: Create `backend/ws/broadcaster.py`**

```python
"""WebSocket broadcasting — single connected_clients set + broadcast helper."""
from __future__ import annotations

from typing import Any

from fastapi import WebSocket


class Broadcaster:
    """Holds connected WebSocket clients and broadcasts JSON events to all."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    def add(self, ws: WebSocket) -> None:
        self._clients.add(ws)

    def remove(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, event: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for ws in self._clients:
            try:
                await ws.send_json(event)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self._clients.discard(ws)


broadcaster = Broadcaster()
```

- [ ] **Step 3: Smoke test**

```bash
pytest tests/test_smoke.py -v
```

- [ ] **Step 4: Commit**

```bash
git add backend/ws/__init__.py backend/ws/broadcaster.py
git commit -m "refactor(ws): extract Broadcaster singleton to ws/broadcaster.py"
```

---

### Task 9: Extract deps/pyrogram_clients.py + queue_service.py

**Files:**
- Create: `backend/deps/__init__.py`
- Create: `backend/deps/pyrogram_clients.py`
- Create: `backend/services/queue_service.py`

- [ ] **Step 1: Create empty `backend/deps/__init__.py`**

```python
```

- [ ] **Step 2: Create `backend/deps/pyrogram_clients.py`**

```python
"""Multi-account Pyrogram client manager.

Each phone number gets its own Client. Default `bot` is named after LOGIN env.
Incoming-message handler is attached at client creation time.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable, Optional

from pyrogram import Client, filters
from pyrogram.handlers import MessageHandler
from pyrogram.types import Message

from config import AppConfig

logger = logging.getLogger(__name__)


class PyrogramClientManager:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._clients: dict[str, Client] = {}
        self._handler_factory: Optional[Callable[[Client, str], Callable]] = None

        proxy = cfg.proxy.to_pyrogram_dict() if cfg.proxy else None
        self._default = Client(
            name=cfg.login,
            api_id=cfg.api_id,
            api_hash=cfg.api_hash,
            proxy=proxy,
            workdir=str(cfg.session_dir),
        )

    @property
    def default(self) -> Client:
        return self._default

    @property
    def all_accounts(self) -> list[str]:
        return list(self._clients.keys())

    def set_incoming_handler_factory(
        self, factory: Callable[[Client, str], Callable]
    ) -> None:
        """Register a factory: factory(client, account) -> async handler(client, message)."""
        self._handler_factory = factory

    def get_or_create(self, account: str) -> Client:
        key = account.strip()
        if not key:
            return self._default
        if key in self._clients:
            return self._clients[key]
        proxy = self._cfg.proxy.to_pyrogram_dict() if self._cfg.proxy else None
        client = Client(
            name=key,
            api_id=self._cfg.api_id,
            api_hash=self._cfg.api_hash,
            proxy=proxy,
            workdir=str(self._cfg.session_dir),
        )
        if self._handler_factory:
            handler = self._handler_factory(client, key)
            client.add_handler(MessageHandler(handler, filters.incoming & ~filters.service))
        self._clients[key] = client
        return client

    async def ensure_connected(self, client: Client) -> None:
        if not client.is_connected:
            try:
                await client.connect()
            except Exception as e:
                logger.warning("connect failed once, retrying: %s", e)
                await client.connect()

    async def stop_all(self) -> None:
        for c in [self._default, *self._clients.values()]:
            try:
                await c.stop()
            except Exception:
                pass
```

- [ ] **Step 3: Create `backend/services/queue_service.py`**

```python
"""In-memory queue of chat IDs awaiting user attention.

Persistence is added in a later plan (Plan 4). For now state is lost on restart,
which matches existing behavior.
"""
from __future__ import annotations

import asyncio
from typing import Optional


class QueueService:
    """Per-account ordered queue of chat IDs.

    Account "" represents the default (single-account) bot.
    """

    def __init__(self) -> None:
        self._order: dict[str, list[int]] = {}
        self._set: dict[str, set[int]] = {}
        self._lock = asyncio.Lock()

    async def add(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id not in self._set[account]:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)

    async def remove(self, account: str, chat_id: int) -> None:
        async with self._lock:
            if account not in self._set:
                return
            if chat_id in self._set[account]:
                self._set[account].discard(chat_id)
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass

    async def move_to_end(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id in self._set[account]:
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass
                self._order[account].append(chat_id)
            else:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)

    async def get(self, account: str) -> list[int]:
        async with self._lock:
            return list(self._order.get(account, []))

    async def replace(self, account: str, chat_ids: list[int]) -> None:
        async with self._lock:
            self._order[account] = list(chat_ids)
            self._set[account] = set(chat_ids)

    async def head(self, account: str) -> Optional[int]:
        order = await self.get(account)
        return order[0] if order else None

    def _ensure_account(self, account: str) -> None:
        self._order.setdefault(account, [])
        self._set.setdefault(account, set())
```

- [ ] **Step 4: Smoke test**

```bash
pytest tests/test_smoke.py -v
```

- [ ] **Step 5: Commit**

```bash
git add backend/deps/__init__.py backend/deps/pyrogram_clients.py backend/services/queue_service.py
git commit -m "refactor: extract PyrogramClientManager and QueueService"
```

---

### Task 10: Extract handlers/incoming.py

**Files:**
- Create: `backend/handlers/__init__.py`
- Create: `backend/handlers/incoming.py`

- [ ] **Step 1: Create empty `backend/handlers/__init__.py`**

```python
```

- [ ] **Step 2: Create `backend/handlers/incoming.py`**

```python
"""Factory for Pyrogram incoming-message handlers.

This phase keeps the existing private-only filter — group support arrives in
Plan 2 alongside folder filtering.
"""
from __future__ import annotations

from typing import Any

from pyrogram import Client
from pyrogram.types import Message

from services.media_utils import extract_media_info
from services.queue_service import QueueService
from ws.broadcaster import Broadcaster


def make_incoming_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
):
    async def handler(client: Client, message: Message) -> None:
        try:
            ctype = getattr(message.chat, "type", None)
            type_name = (
                getattr(ctype, "value", None)
                or (str(ctype).lower() if ctype is not None else "")
            )
        except Exception:
            type_name = ""
        if type_name != "private":
            return

        chat_id = message.chat.id
        await queue_service.add(account, chat_id)
        await broadcaster.broadcast(
            {"type": "queue_update", "account": account, "chat_id": chat_id}
        )

        preview_text = (message.text or message.caption or "").strip()
        media_info = extract_media_info(message)
        author = _format_author(message)

        if preview_text or media_info:
            payload: dict[str, Any] = {
                "id": message.id,
                "text": preview_text,
                "date": int(message.date.timestamp()) if message.date else None,
                "from_user_id": message.from_user.id if message.from_user else None,
                "from_user_name": author,
                "outgoing": message.outgoing,
            }
            payload.update(media_info)
            chat_title = (
                message.chat.title
                if getattr(message.chat, "title", None)
                else (author or "")
            )
            await broadcaster.broadcast(
                {
                    "type": "message",
                    "account": account,
                    "chat_id": chat_id,
                    "chat_title": chat_title,
                    "message": payload,
                }
            )

    return handler


def _format_author(message: Message) -> str | None:
    try:
        if message.from_user:
            first = message.from_user.first_name or ""
            last = (
                f" {message.from_user.last_name}"
                if message.from_user.last_name
                else ""
            )
            return (first + last).strip() or None
        if message.sender_chat:
            return message.sender_chat.title
    except Exception:
        return None
    return None
```

- [ ] **Step 3: Smoke test**

```bash
pytest tests/test_smoke.py -v
```

- [ ] **Step 4: Commit**

```bash
git add backend/handlers/__init__.py backend/handlers/incoming.py
git commit -m "refactor(handlers): extract make_incoming_handler factory"
```

---

### Task 11: Extract deps/auth.py

**Files:**
- Create: `backend/deps/auth.py`

- [ ] **Step 1: Create `backend/deps/auth.py`**

```python
"""FastAPI dependencies for authorization checks against Pyrogram clients."""
from __future__ import annotations

from fastapi import HTTPException
from pyrogram import Client

from deps.pyrogram_clients import PyrogramClientManager


class AuthDeps:
    """Bound to a single PyrogramClientManager instance at app startup."""

    def __init__(self, manager: PyrogramClientManager) -> None:
        self._manager = manager

    async def get_authorized_client(self, account: str = "") -> Client:
        client = (
            self._manager.get_or_create(account)
            if account
            else self._manager.default
        )
        await self._manager.ensure_connected(client)
        try:
            await client.get_me()
        except Exception:
            raise HTTPException(status_code=401, detail="Not authorized")
        return client
```

- [ ] **Step 2: Smoke test**

```bash
pytest tests/test_smoke.py -v
```

- [ ] **Step 3: Commit**

```bash
git add backend/deps/auth.py
git commit -m "refactor(deps): extract AuthDeps.get_authorized_client"
```

---

### Task 12: Extract routers/auth.py

**Files:**
- Create: `backend/routers/__init__.py`
- Create: `backend/routers/auth.py`

- [ ] **Step 1: Create empty `backend/routers/__init__.py`**

```python
```

- [ ] **Step 2: Create `backend/routers/auth.py`**

```python
"""Auth endpoints: send_code, sign_in, /me."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pyrogram.errors import PasswordHashInvalid, SessionPasswordNeeded

from deps.pyrogram_clients import PyrogramClientManager


def make_router(manager: PyrogramClientManager) -> APIRouter:
    router = APIRouter()
    pending_logins: dict[str, str] = {}

    @router.api_route("/auth/send_code", methods=["POST", "OPTIONS"])
    @router.api_route("/auth/send_code/", methods=["POST", "OPTIONS"])
    async def auth_send_code(payload: dict[str, str]):
        phone = payload.get("phone")
        if not phone:
            raise HTTPException(status_code=400, detail="phone is required")

        client = manager.get_or_create(phone)
        await manager.ensure_connected(client)
        try:
            sent = await client.send_code(phone)
            phone_code_hash = (
                getattr(sent, "phone_code_hash", None)
                or getattr(sent, "phone_code", None)
            )
            if not phone_code_hash:
                pending_logins[phone] = ""
                return {"ok": True}
            pending_logins[phone] = phone_code_hash
            return {"ok": True, "phone_code_hash": phone_code_hash}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.api_route("/auth/sign_in", methods=["POST", "OPTIONS"])
    @router.api_route("/auth/sign_in/", methods=["POST", "OPTIONS"])
    async def auth_sign_in(payload: dict[str, str]):
        phone = payload.get("phone")
        code = payload.get("code")
        password = payload.get("password")

        if not phone or not code:
            raise HTTPException(status_code=400, detail="phone and code are required")

        phone_code_hash = pending_logins.get(phone)
        if not phone_code_hash:
            raise HTTPException(status_code=400, detail="send_code must be called first")

        client = manager.get_or_create(phone)
        await manager.ensure_connected(client)

        if password:
            try:
                await client.check_password(password=password)
            except PasswordHashInvalid:
                raise HTTPException(
                    status_code=400,
                    detail="Неверный пароль двухфакторной аутентификации",
                )
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))
        else:
            try:
                await client.sign_in(
                    phone_number=phone,
                    phone_code=code,
                    phone_code_hash=phone_code_hash,
                )
            except SessionPasswordNeeded:
                raise HTTPException(status_code=401, detail="Two-factor password required")
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))

        try:
            me = await client.get_me()
        except Exception:
            me = None
        return {
            "ok": True,
            "me": (
                {"id": me.id, "first_name": me.first_name, "username": me.username}
                if me
                else None
            ),
        }

    @router.get("/me")
    async def get_me(account: str = ""):
        try:
            client = manager.get_or_create(account) if account else manager.default
            await manager.ensure_connected(client)
            me = await client.get_me()
            return {
                "authorized": True,
                "me": {
                    "id": me.id,
                    "first_name": me.first_name,
                    "username": me.username,
                },
            }
        except Exception:
            return {"authorized": False}

    return router
```

- [ ] **Step 3: Smoke test**

```bash
pytest tests/test_smoke.py -v
```

- [ ] **Step 4: Commit**

```bash
git add backend/routers/__init__.py backend/routers/auth.py
git commit -m "refactor(routers): extract auth router"
```

---

### Task 13: Extract routers/dialogs.py + routers/messages.py + routers/queue.py

These three are mechanical lifts — copy the existing handlers into router modules. Since the bodies are identical to current main.py logic, no new tests are added. The smoke test validates app boots after each.

**Files:**
- Create: `backend/routers/dialogs.py`
- Create: `backend/routers/messages.py`
- Create: `backend/routers/queue.py`

- [ ] **Step 1: Create `backend/routers/dialogs.py`**

```python
"""Dialog list, contacts, chat info, bootstrap, contact resolution."""
from __future__ import annotations

import asyncio
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pyrogram import Client

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.queue_service import QueueService

try:
    from pyrogram.raw.functions.contacts import ImportContacts  # type: ignore
    from pyrogram.raw.types import InputPhoneContact  # type: ignore
except Exception:
    ImportContacts = None  # type: ignore
    InputPhoneContact = None  # type: ignore


def _map_dialog(d: Any) -> Optional[dict[str, Any]]:
    chat = getattr(d, "chat", None)
    if not chat:
        return None
    try:
        ctype = getattr(chat, "type", None)
        type_name = (
            getattr(ctype, "value", None)
            or (str(ctype).lower() if ctype is not None else "")
        )
    except Exception:
        type_name = ""
    if type_name not in ("private", "group", "supergroup"):
        return None
    last_text = (
        (getattr(d.top_message, "text", None) or getattr(d.top_message, "caption", None) or "").strip()
        if getattr(d, "top_message", None)
        else None
    )
    if last_text == "":
        last_text = None
    title = getattr(chat, "title", None)
    if not title:
        first_name = getattr(chat, "first_name", None) or ""
        last_name = getattr(chat, "last_name", None) or ""
        title = (first_name + (" " + last_name if last_name else "")).strip() or str(chat.id)
    return {
        "chat_id": chat.id,
        "title": title,
        "type": type_name,
        "username": getattr(chat, "username", None),
        "unread_count": getattr(d, "unread_messages_count", 0),
        "last_message_text": last_text,
    }


async def _build_dialogs_and_queue(client: Client, limit: int = 100) -> dict[str, Any]:
    dialogs: list[dict[str, Any]] = []
    queue_ids: list[int] = []
    seen: set[int] = set()
    async for d in client.get_dialogs(limit=limit):
        item = _map_dialog(d)
        if not item:
            continue
        dialogs.append(item)
        if item["type"] == "private" and int(item.get("unread_count", 0) or 0) > 0:
            cid = int(item["chat_id"])
            if cid not in seen:
                seen.add(cid)
                queue_ids.append(cid)
    return {"dialogs": dialogs, "queue": queue_ids}


def _normalize_phone_e164(phone: str) -> str:
    digits = re.sub(r"\D+", "", phone or "")
    if not digits:
        return phone
    if len(digits) == 11 and (digits.startswith("8") or digits.startswith("7")):
        return "+7" + digits[1:]
    if len(digits) == 10:
        return "+7" + digits
    if digits.startswith("7"):
        return "+" + digits
    return phone if phone.startswith("+") else ("+" + digits)


async def _resolve_user_by_phone(client: Client, phone: str) -> Optional[int]:
    if ImportContacts is None or InputPhoneContact is None:
        return None
    try:
        normalized = _normalize_phone_e164(phone)
        result = await client.invoke(
            ImportContacts(
                contacts=[
                    InputPhoneContact(
                        client_id=0, phone=normalized, first_name=".", last_name=""
                    )
                ]
            )
        )
        users = getattr(result, "users", []) or []
        for u in users:
            uid = getattr(u, "id", None)
            if uid:
                return int(uid)
    except Exception:
        return None
    return None


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
) -> APIRouter:
    router = APIRouter()

    async def _get_contacts_payload(account: str) -> list[dict[str, Any]]:
        client = manager.get_or_create(account) if account else manager.default
        await manager.ensure_connected(client)
        try:
            await client.get_me()
        except Exception:
            raise HTTPException(status_code=401, detail="Not authorized")
        out: list[dict[str, Any]] = []
        try:
            users = await client.get_contacts()
            for u in users:
                first = getattr(u, "first_name", None) or ""
                last = getattr(u, "last_name", None) or ""
                title = (first + (" " + last if last else "")).strip() or str(u.id)
                out.append(
                    {
                        "chat_id": u.id,
                        "title": title,
                        "type": "private",
                        "username": getattr(u, "username", None),
                        "phone": getattr(u, "phone_number", None),
                    }
                )
        except Exception:
            pass
        return out

    @router.get("/contacts")
    async def get_contacts(account: str = ""):
        return {"contacts": await _get_contacts_payload(account)}

    @router.get("/dialogs")
    async def get_dialogs(limit: int = 100, account: str = ""):
        client = await auth.get_authorized_client(account)
        payload = await _build_dialogs_and_queue(client, limit=limit)
        return {"dialogs": payload["dialogs"]}

    @router.get("/bootstrap")
    async def get_bootstrap(limit: int = 100, account: str = ""):
        client = await auth.get_authorized_client(account)
        dialogs_task = asyncio.create_task(_build_dialogs_and_queue(client, limit=limit))
        contacts_task = asyncio.create_task(_get_contacts_payload(account))
        dialogs_payload, contacts_payload = await asyncio.gather(dialogs_task, contacts_task)
        queue_ids = dialogs_payload["queue"]
        await queue_service.replace(account, queue_ids)
        return {
            "dialogs": dialogs_payload["dialogs"],
            "contacts": contacts_payload,
            "queue": queue_ids,
        }

    @router.get("/chat_info")
    async def chat_info(chat_id: int, account: str = ""):
        client = await auth.get_authorized_client(account)
        try:
            ch = await client.get_chat(chat_id)
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))
        try:
            ctype = getattr(ch, "type", None)
            type_name = (
                getattr(ctype, "value", None)
                or (str(ctype).lower() if ctype is not None else "")
            )
        except Exception:
            type_name = ""
        title = getattr(ch, "title", None)
        if not title:
            first_name = getattr(ch, "first_name", None) or ""
            last_name = getattr(ch, "last_name", None) or ""
            title = (first_name + (" " + last_name if last_name else "")).strip() or str(chat_id)
        return {
            "chat": {
                "chat_id": int(getattr(ch, "id", chat_id)),
                "title": title,
                "type": type_name,
                "username": getattr(ch, "username", None),
            }
        }

    @router.post("/resolve_contact")
    async def resolve_contact(payload: dict[str, Any]):
        account = str(payload.get("account", "")).strip()
        client = manager.get_or_create(account) if account else manager.default
        await manager.ensure_connected(client)

        user_id = payload.get("user_id")
        phone = payload.get("phone")
        username = payload.get("username")
        if not user_id and not phone and not username:
            raise HTTPException(status_code=400, detail="user_id or phone or username is required")

        if user_id:
            try:
                uid = int(user_id)
            except Exception:
                raise HTTPException(status_code=400, detail="invalid user_id")
            return {"ok": True, "user_id": uid, "chat_id": uid}

        if phone:
            raw_phone = str(phone).strip()
            uid = await _resolve_user_by_phone(client, raw_phone)
            if uid:
                return {"ok": True, "user_id": uid, "chat_id": uid}
            digits_only = re.sub(r"\D+", "", raw_phone)
            if digits_only:
                try:
                    fallback_uid = int(digits_only)
                except (ValueError, OverflowError):
                    fallback_uid = None
                if fallback_uid is not None:
                    return {"ok": True, "user_id": fallback_uid, "chat_id": fallback_uid}
            raise HTTPException(status_code=404, detail="User not found by phone")

        if username:
            uname = str(username).strip()
            if uname.startswith("@"):
                uname = uname[1:]
            try:
                ch = await client.get_chat(uname)
                try:
                    ctype = getattr(ch, "type", None)
                    type_name = (
                        getattr(ctype, "value", None)
                        or (str(ctype).lower() if ctype is not None else "")
                    )
                except Exception:
                    type_name = ""
                if type_name and type_name != "private":
                    raise HTTPException(status_code=400, detail="Username is not a private user")
                uid = getattr(ch, "id", None)
                if not uid:
                    raise HTTPException(status_code=404, detail="User not found by username")
                return {"ok": True, "user_id": int(uid), "chat_id": int(uid)}
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(status_code=404, detail="User not found by username")

        raise HTTPException(status_code=400, detail="invalid payload")

    return router
```

- [ ] **Step 2: Create `backend/routers/messages.py`**

```python
"""Message history, send, media (download/upload)."""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pyrogram import Client

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.media_utils import extract_media_info


def _format_sender(m) -> Optional[str]:
    if m.from_user:
        first = getattr(m.from_user, "first_name", None) or ""
        last = getattr(m.from_user, "last_name", None) or ""
        return (first + (" " + last if last else "")).strip() or None
    if getattr(m, "sender_chat", None):
        return getattr(m.sender_chat, "title", None)
    return None


def make_router(manager: PyrogramClientManager, auth: AuthDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/messages")
    async def get_messages(
        chat_id: int,
        limit: int = 50,
        before_id: Optional[int] = None,
        account: str = "",
    ):
        client = await auth.get_authorized_client(account)
        history: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"limit": limit}
        if before_id:
            try:
                kwargs["max_id"] = int(before_id) - 1
            except Exception:
                pass
        async for m in client.get_chat_history(chat_id, **kwargs):
            text_content = (m.text or m.caption or "").strip()
            media_info = extract_media_info(m, chat_id=chat_id)
            if not text_content and not media_info:
                continue
            sender_name = _format_sender(m) if not m.outgoing else None
            entry: dict[str, Any] = {
                "id": m.id,
                "text": text_content,
                "date": int(m.date.timestamp()) if m.date else None,
                "from_user_id": m.from_user.id if m.from_user else None,
                "from_user_name": sender_name,
                "outgoing": m.outgoing,
            }
            entry.update(media_info)
            history.append(entry)
        history.reverse()
        return {"chat_id": chat_id, "messages": history}

    @router.get("/media/{chat_id}/{message_id}")
    async def get_media(chat_id: int, message_id: int, account: str = ""):
        client = await auth.get_authorized_client(account)
        try:
            msgs = [
                m
                async for m in client.get_chat_history(
                    chat_id, limit=1, offset_id=message_id + 1
                )
            ]
            if not msgs or msgs[0].id != message_id:
                raise HTTPException(status_code=404, detail="Message not found")
            msg = msgs[0]
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))

        try:
            buf = await client.download_media(msg, in_memory=True)
            if buf is None:
                raise HTTPException(status_code=404, detail="Failed to download media")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        buf.seek(0)

        ct = "application/octet-stream"
        if msg.photo:
            ct = "image/jpeg"
        elif msg.video or msg.video_note:
            ct = "video/mp4"
        elif msg.voice:
            ct = "audio/ogg"
        elif msg.document:
            mime = getattr(msg.document, "mime_type", None)
            if mime:
                ct = mime
        return StreamingResponse(buf, media_type=ct)

    @router.post("/send_media")
    async def api_send_media(
        chat_id: int = Form(...),
        media_type: str = Form(...),
        account: str = Form(""),
        caption: str = Form(""),
        file: UploadFile = File(...),
    ):
        client = await auth.get_authorized_client(account)
        if not getattr(client, "me", None):
            try:
                client.me = await client.get_me()
            except Exception:
                pass

        suffix = Path(file.filename or "file").suffix
        if not suffix:
            suffix = ".ogg" if media_type == "voice" else ".bin"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp_path: Optional[str] = None
        try:
            content = await file.read()
            tmp.write(content)
            tmp.flush()
            tmp_path = tmp.name
            tmp.close()

            sent = None
            if media_type == "photo":
                sent = await client.send_photo(chat_id=chat_id, photo=tmp_path, caption=caption or None)
            elif media_type == "video":
                sent = await client.send_video(chat_id=chat_id, video=tmp_path, caption=caption or None)
            elif media_type == "voice":
                sent = await client.send_voice(chat_id=chat_id, voice=tmp_path, caption=caption or None)
            elif media_type == "document":
                sent = await client.send_document(chat_id=chat_id, document=tmp_path, caption=caption or None)
            else:
                raise HTTPException(status_code=400, detail="Unknown media_type")
            sent_id = sent.id if sent else None
            return {
                "ok": True,
                "message_id": sent_id,
                "media_type": media_type,
                "media_url": f"/media/{chat_id}/{sent_id}" if sent_id else None,
            }
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        finally:
            try:
                if tmp_path:
                    Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                pass

    @router.post("/send_message")
    async def api_send_message(payload: dict[str, Any]):
        account = str(payload.get("account", "")).strip()
        chat_id = payload.get("chat_id")
        text = payload.get("text")
        reply_to_message_id = payload.get("reply_to_message_id")
        if chat_id is None or not text:
            raise HTTPException(status_code=400, detail="chat_id and text are required")
        client = manager.get_or_create(account) if account else manager.default
        await manager.ensure_connected(client)
        try:
            sent = await client.send_message(
                chat_id=chat_id, text=text, reply_to_message_id=reply_to_message_id
            )
            return {"ok": True, "message_id": sent.id}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    return router
```

- [ ] **Step 3: Create `backend/routers/queue.py`**

```python
"""Queue endpoints: list and act on pending chats."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.queue_service import QueueService


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
) -> APIRouter:
    router = APIRouter()

    @router.get("/queue")
    async def get_queue(account: str = ""):
        return {"queue": await queue_service.get(account)}

    @router.post("/queue/action")
    async def queue_action(payload: dict[str, Any]):
        chat_id = payload.get("chat_id")
        action = str(payload.get("action", "")).lower()
        if chat_id is None or action not in {"done", "postpone", "task"}:
            raise HTTPException(status_code=400, detail="chat_id and valid action are required")

        account = str(payload.get("account", "")).strip()
        if action == "done":
            try:
                client = manager.get_or_create(account) if account else manager.default
                await manager.ensure_connected(client)
                await client.read_chat_history(chat_id)
            except Exception:
                pass
            await queue_service.remove(account, chat_id)
        else:
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}

    return router
```

- [ ] **Step 4: Smoke test still passes**

```bash
pytest tests/test_smoke.py -v
```
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/dialogs.py backend/routers/messages.py backend/routers/queue.py
git commit -m "refactor(routers): extract dialogs, messages, queue routers"
```

---

### Task 14: New router/tasks.py + integration tests

**Files:**
- Create: `backend/routers/tasks.py`
- Create: `backend/tests/test_tasks_api.py`

- [ ] **Step 1: Write failing integration tests `backend/tests/test_tasks_api.py`**

```python
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pytest tests/test_tasks_api.py -v
```
Expected: ModuleNotFoundError on `routers.tasks`.

- [ ] **Step 3: Implement `backend/routers/tasks.py`**

```python
"""Tasks CRUD endpoint (TodoPage backend)."""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, HTTPException

from services.task_store import TaskStore


def make_router(task_store: TaskStore) -> APIRouter:
    router = APIRouter()

    @router.get("/tasks")
    async def list_tasks(account: str = ""):
        tasks = await task_store.list(account=account)
        return {"tasks": [asdict(t) for t in tasks]}

    @router.post("/tasks")
    async def create_task(payload: dict[str, Any]):
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        chat_id_raw = payload.get("chat_id")
        chat_id = int(chat_id_raw) if chat_id_raw is not None else None
        chat_title = payload.get("chat_title")
        account = (payload.get("account") or "").strip()
        task = await task_store.create(
            text=text,
            chat_id=chat_id,
            chat_title=chat_title,
            account=account,
        )
        return {"task": asdict(task)}

    @router.patch("/tasks/{task_id}")
    async def patch_task(task_id: str, payload: dict[str, Any]):
        done = payload.get("done")
        text = payload.get("text")
        if done is None and text is None:
            raise HTTPException(status_code=400, detail="done or text is required")
        if text is not None:
            text = str(text).strip()
            if not text:
                raise HTTPException(status_code=400, detail="text cannot be empty")
        if done is not None:
            done = bool(done)
        updated = await task_store.update(task_id, done=done, text=text)
        if updated is None:
            raise HTTPException(status_code=404, detail="task not found")
        return {"task": asdict(updated)}

    @router.delete("/tasks/completed")
    async def clear_completed(account: str = ""):
        removed = await task_store.clear_completed(account=account)
        return {"ok": True, "removed": removed}

    @router.delete("/tasks/{task_id}")
    async def delete_task(task_id: str):
        deleted = await task_store.delete(task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="task not found")
        return {"ok": True}

    return router
```

> **Note:** `/tasks/completed` route is registered before `/tasks/{task_id}` so FastAPI matches it first. Without the right ordering, `DELETE /tasks/completed` would hit the path-parameter handler with `task_id="completed"`.

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_tasks_api.py -v
```
Expected: 11 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/tasks.py backend/tests/test_tasks_api.py
git commit -m "feat(tasks): add /tasks CRUD endpoints with full integration tests"
```

---

### Task 15: New router/ai.py — Claude SDK migration

**Files:**
- Create: `backend/routers/ai.py`

- [ ] **Step 1: Create `backend/routers/ai.py`**

```python
"""AI reply generation via Anthropic Claude (Haiku 4.5)."""
from __future__ import annotations

import logging
from typing import Any, Optional

from anthropic import APIStatusError
from fastapi import APIRouter, HTTPException
from pyrogram import Client

from deps.auth import AuthDeps
from services.claude_client import ClaudeClient

logger = logging.getLogger(__name__)


async def _build_history(client: Client, chat_id: int, *, limit: int = 20) -> list[dict]:
    history: list[dict] = []
    async for m in client.get_chat_history(chat_id, limit=limit):
        text = (m.text or m.caption or "").strip()
        if text:
            role = "assistant" if m.outgoing else "user"
            history.append({"role": role, "content": text})
    history.reverse()
    return history


def make_router(
    claude: Optional[ClaudeClient],
    auth: AuthDeps,
) -> APIRouter:
    router = APIRouter()

    @router.post("/generate_reply")
    async def generate_reply(payload: dict[str, Any]):
        if claude is None:
            raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")
        chat_id_raw = payload.get("chat_id")
        if chat_id_raw is None:
            raise HTTPException(status_code=400, detail="chat_id is required")
        try:
            chat_id = int(chat_id_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="invalid chat_id")
        account = str(payload.get("account", "")).strip()
        user_prompt = str(payload.get("prompt", "")).strip()

        client = await auth.get_authorized_client(account)
        history = await _build_history(client, chat_id, limit=20)
        if not history:
            raise HTTPException(status_code=400, detail="No messages to generate reply from")

        try:
            reply = await claude.generate_reply(
                history, system_prompt=user_prompt or None
            )
        except APIStatusError as e:
            error_type = getattr(e, "type", None) or ""
            logger.error(
                "Claude APIStatusError: type=%s status=%s message=%s",
                error_type,
                e.status_code,
                e.message,
            )
            if error_type == "rate_limit_error":
                raise HTTPException(status_code=429, detail="Claude rate limit, try again")
            if error_type == "overloaded_error":
                raise HTTPException(status_code=503, detail="Claude overloaded")
            raise HTTPException(status_code=502, detail=f"Claude API error: {e.message}")
        except Exception as e:
            logger.exception("Claude unexpected error")
            raise HTTPException(status_code=500, detail=str(e))

        if not reply:
            raise HTTPException(status_code=500, detail="Empty response from Claude")
        return {"ok": True, "reply": reply}

    return router
```

- [ ] **Step 2: Smoke test**

```bash
pytest tests/test_smoke.py -v
```

- [ ] **Step 3: Commit**

```bash
git add backend/routers/ai.py
git commit -m "feat(ai): add /generate_reply router using ClaudeClient (Haiku 4.5)"
```

---

### Task 16: Rewrite main.py — wire everything together

**Files:**
- Modify: `backend/main.py` (replace entire content)

- [ ] **Step 1: Read current `backend/main.py` to confirm what we're replacing**

```bash
wc -l backend/main.py
```
Expected: ~1114 lines.

- [ ] **Step 2: Replace `backend/main.py` with the new slim entrypoint**

```python
"""FastAPI app entrypoint.

All endpoint logic lives in routers/. Services hold state. Handlers wire up
Pyrogram callbacks. This file's job is composition only.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import load_config
from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from handlers.incoming import make_incoming_handler
from routers import ai as ai_router
from routers import auth as auth_router
from routers import dialogs as dialogs_router
from routers import messages as messages_router
from routers import queue as queue_router
from routers import tasks as tasks_router
from services.claude_client import ClaudeClient, ClaudeConfig
from services.queue_service import QueueService
from services.state_store import JsonStore
from services.task_store import TaskStore
from ws.broadcaster import broadcaster

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

cfg = load_config()
manager = PyrogramClientManager(cfg)
queue_service = QueueService()
auth_deps = AuthDeps(manager)

# Wire incoming handler factory once.
manager.set_incoming_handler_factory(
    lambda client, account: make_incoming_handler(queue_service, broadcaster, account)
)

# Attach handler to default client too (it doesn't go through get_or_create).
from pyrogram import filters as _filters
from pyrogram.handlers import MessageHandler as _MessageHandler

_default_handler = make_incoming_handler(queue_service, broadcaster, "")
manager.default.add_handler(
    _MessageHandler(_default_handler, _filters.incoming & ~_filters.service)
)

# State stores.
tasks_json = JsonStore(cfg.session_dir / "tasks.json", default_factory=list)
task_store = TaskStore(tasks_json)

# Optional Claude client.
claude_client: ClaudeClient | None = None
if cfg.anthropic_api_key:
    claude_client = ClaudeClient(ClaudeConfig(api_key=cfg.anthropic_api_key))


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await manager.stop_all()


app = FastAPI(title="TG Backend API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.make_router(manager))
app.include_router(dialogs_router.make_router(manager, auth_deps, queue_service))
app.include_router(messages_router.make_router(manager, auth_deps))
app.include_router(queue_router.make_router(manager, auth_deps, queue_service))
app.include_router(tasks_router.make_router(task_store))
app.include_router(ai_router.make_router(claude_client, auth_deps))


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "service": "TG Backend API",
        "status": "ok",
        "docs": "/docs",
        "endpoints": [
            "/auth/send_code",
            "/auth/sign_in",
            "/me",
            "/dialogs",
            "/messages",
            "/send_message",
            "/queue",
            "/queue/action",
            "/tasks",
            "/generate_reply",
            "/ws",
        ],
    }


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    broadcaster.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        broadcaster.remove(ws)


# Serve built frontend at /app for SPA mode (mounted last so router paths win).
try:
    DIST_DIR = (Path(__file__).parent / "frontend" / "dist").resolve()
    if DIST_DIR.exists():
        app.mount("/app", StaticFiles(directory=str(DIST_DIR), html=True), name="app")
except Exception:
    pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
```

- [ ] **Step 3: Run smoke test — must still pass**

```bash
pytest tests/ -v
```
Expected: 26 tests pass (2 smoke + 6 state_store + 11 task_store + 6 claude_client + 11 tasks_api).

- [ ] **Step 4: Verify line count target**

```bash
wc -l backend/main.py
```
Expected: ≤120 lines (target was 80, slight overrun OK due to handler attach).

- [ ] **Step 5: Manual smoke check (locally)**

Run the dev server and hit endpoints:
```bash
cd backend && source .venv/bin/activate && python main.py &
SERVER_PID=$!
sleep 2
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/
curl -s http://localhost:8080/tasks
kill $SERVER_PID
```
Expected: `{"ok":true}`, root metadata, `{"tasks":[]}`.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py
git commit -m "refactor(main): slim main.py to composition only, wire all routers"
```

---

## Phase D — Frontend: TodoPage migrates to /tasks

### Task 17: tasksApi.ts service

**Files:**
- Create: `frontend/src/services/tasksApi.ts`

- [ ] **Step 1: Inspect base URL conventions in existing api**

```bash
grep -n "API_BASE\|baseUrl\|fetch(" /Users/den1shh/Documents/growfood/tg_focus_app/frontend/src/services/telegramApi.ts | head -10
```
Expected: see `getBaseUrl` or similar helper.

- [ ] **Step 2: Create `frontend/src/services/tasksApi.ts`**

Mirror the base-URL resolution that `telegramApi.ts` uses (`VITE_API_BASE_URL` env var with a fallback). We do not import the singleton — `tasksApi` is independent.

```typescript
export type Task = {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
  chat_id: number | null;
  chat_title: string | null;
  account: string | null;
};

const BASE_URL: string = (() => {
  const envBase = (import.meta as any).env?.VITE_API_BASE_URL as string | undefined;
  return (envBase && envBase.trim()) || 'http://185.250.149.23:8080';
})();

const url = (path: string): string => `${BASE_URL}${path}`;

async function asJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

export const tasksApi = {
  async list(account = ''): Promise<Task[]> {
    const params = account ? `?account=${encodeURIComponent(account)}` : '';
    const data = await asJson<{ tasks: Task[] }>(
      await fetch(url(`/tasks${params}`))
    );
    return data.tasks;
  },

  async create(input: {
    text: string;
    chat_id?: number;
    chat_title?: string;
    account?: string;
  }): Promise<Task> {
    const data = await asJson<{ task: Task }>(
      await fetch(url('/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    );
    return data.task;
  },

  async update(
    id: string,
    patch: { done?: boolean; text?: string }
  ): Promise<Task> {
    const data = await asJson<{ task: Task }>(
      await fetch(url(`/tasks/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    );
    return data.task;
  },

  async remove(id: string): Promise<void> {
    await asJson(
      await fetch(url(`/tasks/${encodeURIComponent(id)}`), { method: 'DELETE' })
    );
  },

  async clearCompleted(account = ''): Promise<number> {
    const params = account ? `?account=${encodeURIComponent(account)}` : '';
    const data = await asJson<{ ok: boolean; removed: number }>(
      await fetch(url(`/tasks/completed${params}`), { method: 'DELETE' })
    );
    return data.removed;
  },
};
```

- [ ] **Step 3: Verify TypeScript compiles**

From `frontend/`:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/tasksApi.ts
git commit -m "feat(frontend): add tasksApi HTTP client"
```

---

### Task 18: Migrate TodoPage to /tasks API + one-shot localStorage migration

**Files:**
- Modify: `frontend/src/pages/TodoPage.tsx`

- [ ] **Step 1: Confirm legacy storage shape**

```bash
grep -n "STORAGE_KEY\|tg_focus_todos\|interface TodoItem" frontend/src/pages/TodoPage.tsx
```
Expected output:
- `const STORAGE_KEY = 'tg_focus_todos';`
- `interface TodoItem { id: string; text: string; done: boolean; createdAt: number; }`

This confirms the legacy localStorage payload is an array of `{id, text, done, createdAt}` — the migration code in Step 2 reads exactly that shape.

- [ ] **Step 2: Replace `frontend/src/pages/TodoPage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ArrowLeft, Check, MessageSquare, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { tasksApi, type Task } from '@/services/tasksApi';

const LEGACY_KEY = 'tg_focus_todos';

type LegacyTodo = { id: string; text: string; done: boolean; createdAt: number };

const TodoPage = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const migrationDone = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await tasksApi.list();
      setTasks(list);
    } catch (e: any) {
      toast.error('Не удалось загрузить задачи: ' + (e.message || ''));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // One-shot migration: read localStorage, POST each, then clear.
  useEffect(() => {
    if (migrationDone.current) return;
    migrationDone.current = true;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) {
      load();
      return;
    }
    try {
      const legacy: LegacyTodo[] = JSON.parse(raw);
      if (!Array.isArray(legacy) || legacy.length === 0) {
        localStorage.removeItem(LEGACY_KEY);
        load();
        return;
      }
      // Sequential to preserve order; failures roll back to leaving localStorage in place.
      (async () => {
        try {
          for (const t of legacy) {
            await tasksApi.create({ text: t.text });
            // Note: legacy `done` and `createdAt` are not preserved — the
            // backend assigns a fresh created_at. Acceptable for a one-shot
            // migration of in-progress task lists.
          }
          localStorage.removeItem(LEGACY_KEY);
          toast.success(`Перенесено ${legacy.length} задач из локального хранилища`);
        } catch (e: any) {
          toast.error('Миграция задач не удалась — localStorage сохранён');
        } finally {
          await load();
        }
      })();
    } catch {
      localStorage.removeItem(LEGACY_KEY);
      load();
    }
  }, [load]);

  const visible = useMemo(() => {
    if (filter === 'open') return tasks.filter(t => !t.done);
    if (filter === 'done') return tasks.filter(t => t.done);
    return tasks;
  }, [tasks, filter]);

  const doneCount = tasks.filter(t => t.done).length;

  const addTask = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const created = await tasksApi.create({ text: trimmed });
      setTasks(prev => [...prev, created]);
      setText('');
    } catch (e: any) {
      toast.error('Не удалось создать задачу');
    }
  }, [text]);

  const toggleTask = useCallback(async (task: Task) => {
    // Optimistic
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: !t.done } : t));
    try {
      await tasksApi.update(task.id, { done: !task.done });
    } catch {
      // Revert
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
      toast.error('Не удалось обновить задачу');
    }
  }, []);

  const removeTask = useCallback(async (task: Task) => {
    setTasks(prev => prev.filter(t => t.id !== task.id));
    try {
      await tasksApi.remove(task.id);
    } catch {
      setTasks(prev => [...prev, task]);
      toast.error('Не удалось удалить задачу');
    }
  }, []);

  const clearDone = useCallback(async () => {
    const before = tasks;
    setTasks(prev => prev.filter(t => !t.done));
    try {
      await tasksApi.clearCompleted();
    } catch {
      setTasks(before);
      toast.error('Не удалось очистить выполненные');
    }
  }, [tasks]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b border-border p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold flex-1">Задачи</h1>
        <span className="text-sm text-muted-foreground tabular-nums">
          {doneCount}/{tasks.length}
        </span>
      </div>

      <div className="p-4 border-b border-border">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addTask();
          }}
        >
          <Input
            placeholder="Новая задача..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <Button type="submit" disabled={!text.trim()}>
            Добавить
          </Button>
        </form>
        <div className="flex gap-2 mt-3 text-sm">
          {(['all', 'open', 'done'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded ${
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              {f === 'all' ? 'Все' : f === 'open' ? 'Активные' : 'Выполненные'}
            </button>
          ))}
          {doneCount > 0 && (
            <button
              onClick={clearDone}
              className="ml-auto px-2 py-1 rounded text-muted-foreground hover:text-foreground"
            >
              Очистить выполненные
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            Загрузка...
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            Нет задач
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((t) => (
              <Card
                key={t.id}
                className="m-2 p-3 flex items-center gap-3"
              >
                <button onClick={() => toggleTask(t)}>
                  {t.done ? <Check className="h-5 w-5" /> : <Square className="h-5 w-5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <span
                    className={`text-sm ${t.done ? 'line-through text-muted-foreground' : ''}`}
                  >
                    {t.text}
                  </span>
                  {t.chat_id != null && t.chat_title && (
                    <button
                      onClick={() => navigate(`/chat/${t.chat_id}`)}
                      className="ml-2 text-xs text-blue-500 inline-flex items-center gap-1 hover:underline"
                    >
                      <MessageSquare className="h-3 w-3" />
                      {t.chat_title}
                    </button>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(t.created_at * 1000).toLocaleDateString('ru-RU')}
                </span>
                <Button variant="ghost" size="icon" onClick={() => removeTask(t)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TodoPage;
```

- [ ] **Step 3: Build frontend, fix any type errors**

From `frontend/`:
```bash
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Manual smoke check**

In a second terminal, run backend (`cd backend && python main.py`), then start frontend dev server (`cd frontend && npm run dev`). Open the TodoPage, verify:
- Empty state renders.
- Create a task → appears.
- Toggle done → state persists across refresh.
- Delete → gone after refresh.
- If you had legacy localStorage entries, they migrated and toast appeared.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/TodoPage.tsx
git commit -m "feat(frontend): migrate TodoPage from localStorage to /tasks API"
```

---

## Phase E — Final verification

### Task 19: Full test suite + manual end-to-end check

- [ ] **Step 1: Run all backend tests**

```bash
cd backend && pytest tests/ -v
```
Expected: 36 tests pass total (2 smoke + 6 state + 11 task store + 6 claude + 11 tasks api).

- [ ] **Step 2: Verify line counts**

```bash
wc -l backend/main.py backend/routers/*.py backend/services/*.py
```
Expected: All files ≤ 400 lines per `coding-style.md`. main.py ≤ 120.

- [ ] **Step 3: Frontend build**

```bash
cd frontend && npm run build
```
Expected: success.

- [ ] **Step 4: Frontend lint**

```bash
npm run lint
```
Expected: no new errors (warnings ok if pre-existing).

- [ ] **Step 5: Manual end-to-end check (requires real API_ID/API_HASH/.env)**

```bash
cd backend && python main.py &
sleep 2

# 1. Health
curl http://localhost:8080/healthz

# 2. Tasks CRUD
curl -X POST http://localhost:8080/tasks -H "Content-Type: application/json" -d '{"text":"e2e test"}'
curl http://localhost:8080/tasks
# (note the id from response, then)
TASK_ID=$(curl -s http://localhost:8080/tasks | python3 -c "import json,sys; print(json.load(sys.stdin)['tasks'][0]['id'])")
curl -X PATCH http://localhost:8080/tasks/$TASK_ID -H "Content-Type: application/json" -d '{"done":true}'
curl -X DELETE http://localhost:8080/tasks/completed
curl http://localhost:8080/tasks  # should be []

# 3. Verify file persistence
cat backend/sessions/tasks.json  # should be []
```
Expected: each step succeeds, tasks.json reflects state.

- [ ] **Step 6: Verify Claude endpoint behavior (requires ANTHROPIC_API_KEY)**

Skip if no key available — endpoint will return 500 "ANTHROPIC_API_KEY not configured" which is expected.

If key is set, requires an authorized session (run after `/auth/sign_in`):
```bash
curl -X POST http://localhost:8080/generate_reply \
  -H "Content-Type: application/json" \
  -d '{"chat_id": <some_chat_id>, "account": "<phone>"}'
```
Expected: `{"ok": true, "reply": "..."}` within ~3 seconds.

- [ ] **Step 7: Final commit (if any cleanup remained)**

```bash
git status
# If nothing to commit:
echo "Plan 1 complete — ready to deploy"
```

- [ ] **Step 8: Push to remote**

```bash
git push origin denis-branch
```

---

## Plan 1 — Definition of Done

- [x] All 36 backend tests pass.
- [x] Frontend builds without TypeScript errors.
- [x] `backend/main.py` ≤ 120 lines.
- [x] No file in `backend/` exceeds 400 lines.
- [x] `/tasks` endpoint works end-to-end (CRUD).
- [x] `/generate_reply` uses `claude-haiku-4-5` with prompt caching and SDK auto-retry.
- [x] TodoPage reads/writes via API, migrates legacy localStorage entries once.
- [x] Pyrogram session and incoming-message handler still work (smoke + manual).
- [x] No regression in `/dialogs`, `/messages`, `/queue`, `/send_message`, `/media`, `/auth/*`.

After this ships, **Plan 2** (folders + queue extension to non-private chats + WS payload) becomes safe to write since the backend is now modular and persistence-ready.
