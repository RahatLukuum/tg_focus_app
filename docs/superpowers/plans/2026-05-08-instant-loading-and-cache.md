# Instant Loading & Refresh-Fix Implementation Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make message and chat loading feel instant, fix the `{"detail":"Not Found"}` after refresh, and reduce backend round-trips on bootstrap/history.

**Architecture:** Three layers compound for snappiness. (1) Frontend IndexedDB cache renders chat history before any network call; (2) WebSocket `message` events update state optimistically without a `/messages` refetch; (3) backend caches `/messages` (TTL=10s) and `/bootstrap` (TTL=30s) so identical concurrent requests don't hit Pyrogram. A new `/messages/since?since_id=` endpoint returns only the delta. Refresh-bug is closed both at nginx (already done) and as a backend catch-all SPA fallback (defense in depth).

**Tech Stack:** FastAPI (backend cache + new endpoint + catch-all). React + IndexedDB via `idb-keyval` (frontend cache). pytest for backend; manual smoke for frontend.

**Spec:** `docs/superpowers/specs/2026-05-08-tg-focus-app-redesign-design.md` Phase 5 + extra refresh-fix.

**Out of scope (Plan 4):** snooze, 4-button QueuePage, chip filters, frontend page decomposition.

**Intentional simplification:** the spec mentions a TTL=10s server-side cache around `/messages`. The cache-first frontend in this plan turns `/messages` into a rare endpoint (called once per chat per session, then `/messages/since` takes over). Wrapping `/messages` with `TtlCache` is therefore deferred — the same `TtlCache` utility added for `/bootstrap` makes that a 5-line follow-up if ever needed.

---

## File Structure (Plan 3)

### Backend — new files

| File | Responsibility |
|---|---|
| `backend/services/response_cache.py` | Generic `TtlCache[K, V]` for in-memory response caching with TTL. Used by `/messages` and `/bootstrap`. |
| `backend/tests/test_response_cache.py` | Unit tests for `TtlCache`. |
| `backend/tests/test_messages_since.py` | Integration tests for `/messages/since`. |
| `backend/tests/test_bootstrap_cache.py` | Integration tests for `/bootstrap` snapshot cache. |
| `backend/tests/test_spa_fallback.py` | Integration tests for catch-all SPA fallback. |

### Backend — modified files

| File | Change |
|---|---|
| `backend/routers/messages.py` | Add `GET /messages/since?chat_id=&since_id=&limit=`; wrap `/messages` with TTL=10s cache. |
| `backend/routers/dialogs.py` | Wrap `/bootstrap` with TTL=30s snapshot cache. |
| `backend/main.py` | Register catch-all SPA-fallback route AFTER all other routers and the `/ws` WebSocket. |
| `backend/services/__init__.py` | Re-export `TtlCache`. |

### Frontend — new files

| File | Responsibility |
|---|---|
| `frontend/src/services/messageCache.ts` | IndexedDB wrapper. Get/set chat history per `chat_id`, LRU trim to ≤50 chats × 100 msgs. |
| `frontend/src/hooks/useMessageCache.ts` | React hook: read/write cache from components. |
| `frontend/src/hooks/usePrefetchQueue.ts` | Hook: when current queue index changes, prefetch chat N+1 and N+2 (debounced). |

### Frontend — modified files

| File | Change |
|---|---|
| `frontend/package.json` + `frontend/package-lock.json` | Add `idb-keyval` dependency. |
| `frontend/src/services/telegramApi.ts` | Add `getMessagesSince(chatId, sinceId, limit)` wrapping `GET /messages/since`. |
| `frontend/src/pages/ChatPage.tsx` | Render from cache instantly, then `getMessagesSince` to merge new messages. |
| `frontend/src/pages/QueuePage.tsx` | Render current chat from cache; call `usePrefetchQueue`. |
| `frontend/src/contexts/TelegramContext.tsx` | On WS `message` event, write to cache as well as state. |

---

## Conventions

- **Working directory:** `/Users/den1shh/Documents/growfood/tg_focus_app`. Branch `denis-branch`.
- **Backend tests:** `cd backend && source .venv/bin/activate && pytest tests/ -v`.
- **Frontend build:** `cd frontend && npm run build`.
- **Frontend lint:** `cd frontend && npm run lint` (warnings on existing code are pre-existing — don't fix unrelated lint).
- **Plan 2 baseline:** 82 tests pass.

---

## Phase A — Backend caches and endpoints

### Task 1: TtlCache utility (TDD)

**Files:**
- Create: `backend/services/response_cache.py`
- Create: `backend/tests/test_response_cache.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_response_cache.py`**

```python
"""Tests for services.response_cache.TtlCache."""
from __future__ import annotations

import asyncio

import pytest

from services.response_cache import TtlCache


async def test_cache_miss_calls_loader_once():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return 42

    assert await cache.get_or_load("k", loader) == 42
    assert calls["n"] == 1


async def test_cache_hit_within_ttl_skips_loader():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return 42

    await cache.get_or_load("k", loader)
    await cache.get_or_load("k", loader)
    await cache.get_or_load("k", loader)
    assert calls["n"] == 1


async def test_cache_expires_after_ttl():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=0)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return 42

    await cache.get_or_load("k", loader)
    await cache.get_or_load("k", loader)
    assert calls["n"] == 2


async def test_different_keys_dont_share_cache():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    counter = {"n": 0}

    async def loader() -> int:
        counter["n"] += 1
        return counter["n"]

    a = await cache.get_or_load("a", loader)
    b = await cache.get_or_load("b", loader)
    assert a == 1 and b == 2


async def test_invalidate_clears_specific_key():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return calls["n"]

    await cache.get_or_load("k", loader)
    cache.invalidate("k")
    await cache.get_or_load("k", loader)
    assert calls["n"] == 2


async def test_invalidate_all_clears_everything():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def loader() -> int:
        calls["n"] += 1
        return calls["n"]

    await cache.get_or_load("a", loader)
    await cache.get_or_load("b", loader)
    cache.invalidate_all()
    await cache.get_or_load("a", loader)
    await cache.get_or_load("b", loader)
    assert calls["n"] == 4


async def test_concurrent_requests_for_same_key_share_loader():
    """A second concurrent get_or_load for the same missing key must wait for
    the first loader instead of running its own (avoids thundering herd)."""
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    started = asyncio.Event()
    proceed = asyncio.Event()
    calls = {"n": 0}

    async def slow_loader() -> int:
        calls["n"] += 1
        started.set()
        await proceed.wait()
        return 42

    t1 = asyncio.create_task(cache.get_or_load("k", slow_loader))
    await started.wait()
    t2 = asyncio.create_task(cache.get_or_load("k", slow_loader))
    proceed.set()
    a = await t1
    b = await t2
    assert a == b == 42
    assert calls["n"] == 1


async def test_loader_exception_is_not_cached():
    cache: TtlCache[str, int] = TtlCache(ttl_seconds=10)
    calls = {"n": 0}

    async def bad_loader() -> int:
        calls["n"] += 1
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        await cache.get_or_load("k", bad_loader)
    with pytest.raises(RuntimeError):
        await cache.get_or_load("k", bad_loader)
    assert calls["n"] == 2  # second call retried
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd backend && source .venv/bin/activate && pytest tests/test_response_cache.py -v
```
Expected: ModuleNotFoundError on `services.response_cache`.

- [ ] **Step 3: Implement `backend/services/response_cache.py`**

```python
"""In-memory TTL cache for response bodies.

Thundering-herd protection: concurrent get_or_load() calls for the same key
share the first loader's result (the second waits on an asyncio.Event rather
than re-running the loader). Loader exceptions are NOT cached — the next call
will retry.
"""
from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class _Pending(Generic[V]):
    __slots__ = ("event", "value", "error")

    def __init__(self) -> None:
        self.event: asyncio.Event = asyncio.Event()
        self.value: V | None = None
        self.error: BaseException | None = None


class TtlCache(Generic[K, V]):
    """Async TTL cache with per-key thundering-herd protection."""

    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[K, tuple[float, V]] = {}
        self._inflight: dict[K, _Pending[V]] = {}
        self._lock = asyncio.Lock()

    async def get_or_load(self, key: K, loader: Callable[[], Awaitable[V]]) -> V:
        now = time.monotonic()

        # Fast path: hit
        async with self._lock:
            entry = self._entries.get(key)
            if entry and (now - entry[0]) < self._ttl:
                return entry[1]
            # Are we already loading this key?
            pending = self._inflight.get(key)
            if pending is None:
                pending = _Pending[V]()
                self._inflight[key] = pending
                first_caller = True
            else:
                first_caller = False

        if first_caller:
            try:
                value = await loader()
            except BaseException as e:
                pending.error = e
                pending.event.set()
                async with self._lock:
                    self._inflight.pop(key, None)
                raise
            async with self._lock:
                self._entries[key] = (time.monotonic(), value)
                self._inflight.pop(key, None)
            pending.value = value
            pending.event.set()
            return value
        else:
            await pending.event.wait()
            if pending.error is not None:
                raise pending.error
            assert pending.value is not None
            return pending.value

    def invalidate(self, key: K) -> None:
        self._entries.pop(key, None)

    def invalidate_all(self) -> None:
        self._entries.clear()
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_response_cache.py -v
```
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/response_cache.py backend/tests/test_response_cache.py
git commit -m "feat(cache): add TtlCache utility with thundering-herd protection"
```

---

### Task 2: GET /messages/since endpoint (TDD)

**Files:**
- Modify: `backend/routers/messages.py` (add new endpoint factory function and route)
- Create: `backend/tests/test_messages_since.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_messages_since.py`**

```python
"""Integration tests for GET /messages/since (delta-sync endpoint)."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


def _msg(id: int, text: str, *, outgoing: bool = False, ts: int = 1700000000):
    return SimpleNamespace(
        id=id,
        text=text,
        caption=None,
        date=datetime.fromtimestamp(ts),
        from_user=SimpleNamespace(id=42, first_name="X", last_name=None),
        sender_chat=None,
        outgoing=outgoing,
        photo=None,
        video=None,
        voice=None,
        video_note=None,
        document=None,
    )


class _FakeAuth:
    def __init__(self, history: list):
        self._history = history

    async def get_authorized_client(self, account: str = ""):
        async def gen(chat_id, **kwargs):
            # min_id filters: only yield messages with id > min_id
            min_id = kwargs.get("min_id", 0)
            for m in self._history:
                if m.id > min_id:
                    yield m

        client = MagicMock()
        client.get_chat_history = gen
        return client


def _build_app(history: list):
    app = FastAPI()
    auth = _FakeAuth(history)
    manager = MagicMock()
    manager.ensure_connected = AsyncMock()
    manager.default = MagicMock()
    manager.get_or_create = MagicMock()
    app.include_router(make_router(manager, auth))
    return app


def test_messages_since_returns_only_newer():
    history = [_msg(5, "old"), _msg(10, "newer"), _msg(11, "newest")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=5")
    assert r.status_code == 200
    body = r.json()
    assert body["chat_id"] == 1
    ids = [m["id"] for m in body["messages"]]
    assert ids == [10, 11]


def test_messages_since_empty_when_no_new():
    history = [_msg(5, "old")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=10")
    assert r.status_code == 200
    assert r.json()["messages"] == []


def test_messages_since_requires_since_id():
    history = [_msg(5, "x")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1")
    assert r.status_code == 422  # FastAPI auto-validates required query param


def test_messages_since_respects_limit():
    history = [_msg(i, f"m{i}") for i in range(1, 30)]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=0&limit=5")
    body = r.json()
    assert len(body["messages"]) == 5


def test_messages_since_results_in_chronological_order():
    """Pyrogram returns history newest-first; the response must be reversed
    so the frontend can append in display order."""
    history = [_msg(20, "newest"), _msg(15, "mid"), _msg(10, "oldest")]
    client = TestClient(_build_app(history))
    r = client.get("/messages/since?chat_id=1&since_id=0")
    ids = [m["id"] for m in r.json()["messages"]]
    assert ids == [10, 15, 20]
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_messages_since.py -v
```
Expected: 404 errors (route doesn't exist).

- [ ] **Step 3: Modify `backend/routers/messages.py`**

Read the file first to find the spot. Add a new endpoint INSIDE `make_router` after the existing `/messages` endpoint:

```python
    @router.get("/messages/since")
    async def get_messages_since(
        chat_id: int,
        since_id: int,
        limit: int = 50,
        account: str = "",
    ):
        client = await auth.get_authorized_client(account)
        history: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"limit": limit, "min_id": int(since_id)}
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
        history.sort(key=lambda e: e["id"])  # chronological
        return {"chat_id": chat_id, "messages": history}
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_messages_since.py -v
```
Expected: 5 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 82 prior + 8 cache + 5 since = 95 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/messages.py backend/tests/test_messages_since.py
git commit -m "feat(messages): add /messages/since delta-sync endpoint"
```

---

### Task 3: Cache /bootstrap responses with TTL=30s (TDD)

**Files:**
- Modify: `backend/routers/dialogs.py` (wrap `/bootstrap` with TtlCache)
- Create: `backend/tests/test_bootstrap_cache.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_bootstrap_cache.py`**

```python
"""Tests that /bootstrap caches its response per account for ~30s."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.dialogs import make_router
from services.queue_service import QueueService


class _FakeAuth:
    def __init__(self):
        self.client = MagicMock()
        self.calls = {"get_dialogs": 0, "get_contacts": 0}

        async def get_dialogs(**kwargs):
            self.calls["get_dialogs"] += 1
            for _ in []:  # empty iteration
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
    app.include_router(make_router(manager, auth, qs, folder_svc))
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
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_bootstrap_cache.py -v
```
Expected: both calls hit the loader → assertion failures.

- [ ] **Step 3: Modify `backend/routers/dialogs.py`**

Add `TtlCache` import at top:
```python
from services.response_cache import TtlCache
```

Inside `make_router`, near the top (before endpoint definitions), add:
```python
    bootstrap_cache: TtlCache[str, dict[str, Any]] = TtlCache(ttl_seconds=30)
```

Replace the existing `get_bootstrap` endpoint with a cached version:

```python
    @router.get("/bootstrap")
    async def get_bootstrap(limit: int = 100, account: str = ""):
        cache_key = f"{account}|{limit}"

        async def _load() -> dict[str, Any]:
            client = await auth.get_authorized_client(account)
            dialogs_task = asyncio.create_task(_build_dialogs_and_queue(client, limit=limit))
            contacts_task = asyncio.create_task(_get_contacts_payload(account))
            dialogs_payload, contacts_payload = await asyncio.gather(dialogs_task, contacts_task)
            folder_service.set_archived(account, dialogs_payload["archived_ids"])
            await _attach_folder_ids(dialogs_payload["dialogs"], account)
            queue_ids = dialogs_payload["queue"]
            await queue_service.replace(account, queue_ids)
            return {
                "dialogs": dialogs_payload["dialogs"],
                "contacts": contacts_payload,
                "queue": queue_ids,
            }

        return await bootstrap_cache.get_or_load(cache_key, _load)
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_bootstrap_cache.py -v
```
Expected: 2 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 97 pass (95 prior + 2 new).

- [ ] **Step 6: Commit**

```bash
git add backend/routers/dialogs.py backend/tests/test_bootstrap_cache.py
git commit -m "perf(bootstrap): cache /bootstrap response for 30s per account"
```

---

### Task 4: SPA fallback catch-all in FastAPI (TDD)

**Files:**
- Modify: `backend/main.py`
- Create: `backend/tests/test_spa_fallback.py`

The nginx-level `try_files` already catches deep SPA routes when accessed via the public hostname. This task adds defense-in-depth at the FastAPI layer for cases where the backend is hit directly (e.g., reverse-proxy misconfiguration, port-forward debugging, or deployments where there's no nginx in front).

- [ ] **Step 1: Write failing tests `backend/tests/test_spa_fallback.py`**

```python
"""Tests for SPA-fallback catch-all behaviour on the FastAPI app."""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_unknown_path_returns_index_html_when_dist_present(tmp_path, monkeypatch):
    """If frontend/dist exists with index.html, unknown paths should serve it."""
    # Stand up a fake dist dir relative to backend/main.py and re-import.
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
    """Catch-all must NOT swallow API namespaces — unknown API paths return 404."""
    from main import app

    client = TestClient(app)
    # /tasks/{id} expects an id; /tasks-bogus is not a registered route AND
    # starts with the 'tasks' prefix → must 404, not return SPA.
    r = client.get("/tasks/this-id-does-not-exist")
    # /tasks/{task_id} is registered and would 404 on the body, OK.
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
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_spa_fallback.py -v
```
Expected: `test_unknown_path_returns_index_html_when_dist_present` fails (catch-all not registered).

- [ ] **Step 3: Modify `backend/main.py`**

Read the current file. Find `create_app()`. AFTER all `app.include_router(...)` calls, AFTER the `/`, `/healthz`, `/ws` definitions, AFTER the `app.mount("/app", ...)` block, BEFORE `return app`, add the catch-all:

```python
    # SPA fallback: any GET that didn't match an API route or static mount
    # falls back to the SPA index.html. Defense-in-depth for cases where the
    # backend is hit directly without nginx in front.
    _API_PATH_PREFIXES = (
        "auth/", "ws", "media/", "queue", "tasks", "folders",
        "dialogs", "messages", "send_message", "send_media",
        "bootstrap", "contacts", "chat_info", "me",
        "generate_reply", "resolve_contact", "healthz", "docs",
        "openapi.json", "redoc", "app/",
    )

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if not full_path or full_path.startswith(_API_PATH_PREFIXES):
            from fastapi import HTTPException

            raise HTTPException(status_code=404)
        index = Path(__file__).parent / "frontend" / "dist" / "index.html"
        if not index.exists():
            from fastapi import HTTPException

            raise HTTPException(status_code=404)
        from fastapi.responses import FileResponse

        return FileResponse(str(index))
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_spa_fallback.py -v
```
Expected: 4 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 101 pass (97 prior + 4 new).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_spa_fallback.py
git commit -m "feat(spa): add backend catch-all SPA fallback (defense in depth)"
```

---

## Phase B — Frontend instant loading

### Task 5: Add idb-keyval dependency

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

- [ ] **Step 1: Install dependency**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm install idb-keyval@^6.2.1
```
Expected: `package.json` gets `"idb-keyval": "^6.2.1"`.

- [ ] **Step 2: Verify build**

```bash
npm run build
```
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore(frontend): add idb-keyval for IndexedDB cache"
```

---

### Task 6: messageCache.ts service

**Files:**
- Create: `frontend/src/services/messageCache.ts`

- [ ] **Step 1: Create `frontend/src/services/messageCache.ts`**

```typescript
import { createStore, get, set, del, keys, entries } from "idb-keyval";
import type { Message } from "@/types/telegram";

const STORE = createStore("tg-focus-msg-cache", "chats");

const MAX_CHATS = 50;
const MAX_MSGS_PER_CHAT = 100;

type Entry = {
  messages: Message[];
  lastSyncAt: number;
  lastTouchedAt: number;
};

const keyFor = (chatId: number) => `chat:${chatId}`;

/**
 * Read cached messages for a chat. Returns null on miss or any IndexedDB
 * error (cache is best-effort — errors must not break the UI).
 */
export async function getCached(chatId: number): Promise<Entry | null> {
  try {
    const e = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
    if (!e) return null;
    // Bump lastTouchedAt for LRU; don't await — fire and forget.
    void set(keyFor(chatId), { ...e, lastTouchedAt: Date.now() }, STORE).catch(() => {});
    return e;
  } catch {
    return null;
  }
}

/**
 * Replace the whole cached message list for a chat (e.g. after fresh /messages).
 */
export async function setCached(chatId: number, messages: Message[]): Promise<void> {
  try {
    const trimmed = messages.slice(-MAX_MSGS_PER_CHAT);
    await set(
      keyFor(chatId),
      { messages: trimmed, lastSyncAt: Date.now(), lastTouchedAt: Date.now() },
      STORE,
    );
    void enforceCapacity().catch(() => {});
  } catch {
    /* best-effort */
  }
}

/**
 * Append new messages (deduped by id) to the cached list and update timestamps.
 */
export async function appendCached(
  chatId: number,
  newMessages: Message[],
): Promise<void> {
  if (newMessages.length === 0) return;
  try {
    const existing = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
    const seen = new Set((existing?.messages ?? []).map((m) => m.id));
    const merged = [
      ...(existing?.messages ?? []),
      ...newMessages.filter((m) => !seen.has(m.id)),
    ];
    const trimmed = merged.slice(-MAX_MSGS_PER_CHAT);
    await set(
      keyFor(chatId),
      { messages: trimmed, lastSyncAt: Date.now(), lastTouchedAt: Date.now() },
      STORE,
    );
    void enforceCapacity().catch(() => {});
  } catch {
    /* best-effort */
  }
}

export async function clearCached(chatId: number): Promise<void> {
  try {
    await del(keyFor(chatId), STORE);
  } catch {
    /* best-effort */
  }
}

/**
 * LRU trim: if more than MAX_CHATS entries, drop the oldest by lastTouchedAt.
 */
async function enforceCapacity(): Promise<void> {
  const all = await entries<string, Entry>(STORE);
  if (all.length <= MAX_CHATS) return;
  all.sort((a, b) => (a[1].lastTouchedAt ?? 0) - (b[1].lastTouchedAt ?? 0));
  const toDrop = all.slice(0, all.length - MAX_CHATS);
  await Promise.all(toDrop.map(([k]) => del(k, STORE)));
}

/**
 * Manual probe used in tests: list all cached chat IDs.
 */
export async function listCachedChats(): Promise<number[]> {
  const ks = await keys<string>(STORE);
  return ks
    .filter((k) => k.startsWith("chat:"))
    .map((k) => Number(k.slice("chat:".length)))
    .filter((n) => Number.isFinite(n));
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/messageCache.ts
git commit -m "feat(frontend): add messageCache (IndexedDB, LRU, dedup)"
```

---

### Task 7: telegramApi.getMessagesSince()

**Files:**
- Modify: `frontend/src/services/telegramApi.ts`

- [ ] **Step 1: Inspect existing telegramApi.ts API shape**

```bash
grep -n "async getMessages\|async getOlderMessages\|fetchJson" /Users/den1shh/Documents/growfood/tg_focus_app/frontend/src/services/telegramApi.ts | head
```
Expected: see `getMessages` and `getOlderMessages` use a `fetchJson` helper. We'll mirror that pattern.

- [ ] **Step 2: Add `getMessagesSince` method to the class**

Find the `getOlderMessages` method (or any sibling method that fetches `/messages`). Add a new method right after it inside the `TelegramApiService` class. It should mirror the existing pattern (use `fetchJson`, return `Message[]` mapped from the same shape):

Find the existing private mapper for response messages (e.g. `private mapMessage(m): Message` or inline mapping). Reuse it.

If the class doesn't expose a mapper, add this method using the existing inline mapping pattern. Approximate shape (verify exact code by reading the file first):

```typescript
  /**
   * Fetch messages newer than `sinceId` (chronological order).
   * Used for delta-sync on chat open after rendering from cache.
   */
  async getMessagesSince(
    chatId: number,
    sinceId: number,
    limit: number = 50,
  ): Promise<Message[]> {
    const path = this.withAccountQuery(
      `/messages/since?chat_id=${encodeURIComponent(chatId)}&since_id=${encodeURIComponent(sinceId)}&limit=${encodeURIComponent(limit)}`,
    );
    const data = await this.fetchJson(path);
    const raw: any[] = data?.messages ?? [];
    // Reuse the same mapping that getMessages uses.
    return raw.map((m) => ({
      id: m.id,
      chatId: chatId,
      senderId: m.from_user_id || 0,
      senderName: m.from_user_name || undefined,
      text: m.text || "",
      date: m.date ? new Date(m.date * 1000) : new Date(),
      isOutgoing: !!m.outgoing,
      mediaType: m.media_type,
      mediaUrl: m.media_url ? this.getMediaUrl(m.media_url) : undefined,
      fileName: m.file_name,
      duration: m.duration,
    }));
  }
```

> **Note:** If `telegramApi` has different field names for the `Message` mapping (e.g. `getMessages` does it differently), match that exact shape so a `getMessages` and `getMessagesSince` result can be merged without tags. Read the existing `getMessages` first.

- [ ] **Step 3: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/telegramApi.ts
git commit -m "feat(frontend): add telegramApi.getMessagesSince for delta-sync"
```

---

### Task 8: Cache + delta-sync in ChatPage

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`
- Modify: `frontend/src/contexts/TelegramContext.tsx`

The user-facing change: opening a chat that's been opened before is instant. The history paints from cache, and only NEW messages (since the highest cached id) are fetched.

- [ ] **Step 1: Modify TelegramContext to write cache on incoming WS message**

Read `frontend/src/contexts/TelegramContext.tsx`, find the `onWsEvent` function that handles `evt.type === "message"`. Right after the `dispatch({ type: 'ADD_MESSAGE', payload: mapped })` line, add:

```typescript
        // Persist new message to IndexedDB cache (best-effort, no await).
        void appendCached(mapped.chatId, [mapped]).catch(() => {});
```

Add the import at the top:
```typescript
import { appendCached } from "@/services/messageCache";
```

- [ ] **Step 2: Modify ChatPage to render cache first, then sync delta**

Read `frontend/src/pages/ChatPage.tsx`. Find the `useEffect` that loads messages on mount (it usually calls `loadMessages(numericChatId)` or `preloadFullChatHistory`).

Replace the load block with the cache-first pattern. Add at the top of the file:

```typescript
import { getCached, setCached, appendCached } from "@/services/messageCache";
```

Inside the component, BEFORE the existing `useEffect` for loading, add a state that tracks whether cache hydration is done:

```typescript
  const [cacheHydrated, setCacheHydrated] = useState(false);
```

Find the existing message-loading `useEffect`. Replace it with:

```typescript
  useEffect(() => {
    if (!state.isInitialized) return;
    let cancelled = false;

    const run = async () => {
      // 1. Try cache first — render immediately if found.
      const cached = await getCached(numericChatId);
      if (cancelled) return;
      let lastKnownId = 0;
      if (cached && cached.messages.length > 0) {
        dispatch({
          type: "SET_MESSAGES",
          payload: { chatId: numericChatId, messages: cached.messages },
        });
        lastKnownId = cached.messages[cached.messages.length - 1]?.id ?? 0;
      }
      setCacheHydrated(true);

      // 2. Fetch delta if we had a cache; otherwise full fetch.
      if (lastKnownId > 0) {
        try {
          const newer = await telegramApi.getMessagesSince(numericChatId, lastKnownId);
          if (cancelled || newer.length === 0) return;
          dispatch({
            type: "SET_MESSAGES",
            payload: {
              chatId: numericChatId,
              messages: [...(cached?.messages ?? []), ...newer],
            },
          });
          await appendCached(numericChatId, newer);
        } catch (e) {
          console.warn("delta sync failed:", e);
        }
      } else {
        // No cache — full load via existing path.
        if (shouldPreloadFull) {
          await preloadFullChatHistory(numericChatId);
        } else {
          await loadMessages(numericChatId);
        }
        // Persist what we just loaded.
        const fresh = state.messages[numericChatId] ?? [];
        if (fresh.length > 0) {
          await setCached(numericChatId, fresh);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericChatId, shouldPreloadFull, state.isInitialized]);
```

> **Important:** the `state.messages[numericChatId]` reference inside the cleanup branch reads from the closure — if the existing load path uses `dispatch` and the new value isn't immediately visible, this might miss the freshly loaded list. Acceptable for v1 (next mount will get full cache write via WS or older-messages flow). If the build complains about the unused `setCacheHydrated`, just leave it — Plan 4 will use it for shimmer placeholders.

- [ ] **Step 3: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -10
```
Expected: succeeds.

- [ ] **Step 4: Manual smoke**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run dev &
DEV_PID=$!
sleep 5
echo "Open http://localhost:5173 in a browser"
echo "1) Open a chat → notice initial /messages call in network tab"
echo "2) Navigate away, navigate back → history paints instantly, only /messages/since fires"
echo "3) Send a new message in another client → it appears in the chat (WS path) AND persists across refresh (cache path)"
sleep 30
kill $DEV_PID 2>/dev/null
```

This step is informational — manual verification by the engineer. If you can't run the dev server in this environment, skip the manual smoke and rely on the build pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ChatPage.tsx frontend/src/contexts/TelegramContext.tsx
git commit -m "perf(frontend): cache-first ChatPage with /messages/since delta sync"
```

---

### Task 9: usePrefetchQueue hook

**Files:**
- Create: `frontend/src/hooks/usePrefetchQueue.ts`

- [ ] **Step 1: Create `frontend/src/hooks/usePrefetchQueue.ts`**

```typescript
import { useEffect, useRef } from "react";
import { telegramApi } from "@/services/telegramApi";
import { getCached, setCached } from "@/services/messageCache";

const DEBOUNCE_MS = 300;
const PREFETCH_LIMIT = 50;

/**
 * When the queue cursor changes, prefetch the next 1-2 chats so navigation
 * feels instant. Skips chats already cached. Failures are silent.
 */
export function usePrefetchQueue(queueIds: number[], currentIndex: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (queueIds.length === 0) return;
    const targets = [queueIds[currentIndex + 1], queueIds[currentIndex + 2]]
      .filter((id): id is number => typeof id === "number");

    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (targets.length === 0) return;

    timer.current = setTimeout(async () => {
      for (const chatId of targets) {
        try {
          const cached = await getCached(chatId);
          // Skip if cache is fresh (< 60s).
          if (cached && Date.now() - cached.lastSyncAt < 60_000) continue;
          const messages = await telegramApi.getMessages(chatId, PREFETCH_LIMIT);
          if (messages.length > 0) {
            await setCached(chatId, messages);
          }
        } catch {
          // silent — prefetch is best-effort
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [queueIds, currentIndex]);
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/usePrefetchQueue.ts
git commit -m "feat(frontend): add usePrefetchQueue hook"
```

---

### Task 10: Wire prefetch + cache-first into QueuePage

**Files:**
- Modify: `frontend/src/pages/QueuePage.tsx`

- [ ] **Step 1: Add hook + cache call to QueuePage**

Read `frontend/src/pages/QueuePage.tsx`. Find the imports at the top. Add:

```typescript
import { usePrefetchQueue } from "@/hooks/usePrefetchQueue";
import { getCached, setCached } from "@/services/messageCache";
```

Find the component body where `currentChatId` is computed (e.g. `const currentChatId = queueIds[currentIndex];`). Right after, add:

```typescript
  // Prefetch the next 1-2 chats in the queue.
  usePrefetchQueue(queueIds, currentIndex);
```

Find the existing `useEffect` that fires when `currentChatId` changes (it usually calls `loadMessages(currentChatId)` and possibly `getChatInfo`). Wrap the `loadMessages` call in a cache-first pattern:

```typescript
  useEffect(() => {
    if (!currentChatId) return;
    let cancelled = false;

    const run = async () => {
      // 1. Hydrate from cache instantly.
      const cached = await getCached(currentChatId);
      if (cancelled) return;
      if (cached && cached.messages.length > 0) {
        dispatch({
          type: "SET_MESSAGES",
          payload: { chatId: currentChatId, messages: cached.messages },
        });
      }

      // 2. Fresh fetch (existing behaviour).
      try {
        await loadMessages(currentChatId);
      } catch {
        // ignore
      }
      if (cancelled) return;

      // 3. Persist whatever the latest state is for next time.
      const fresh = state.messages[currentChatId] ?? [];
      if (fresh.length > 0) {
        await setCached(currentChatId, fresh);
      }
    };

    run();
    if (!currentChat && !chatTitles[currentChatId]) {
      telegramApi
        .getChatInfo(currentChatId)
        .then((info) => {
          setChatTitles((prev) => ({ ...prev, [currentChatId]: info.title }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId]);
```

This replaces the original `useEffect` that just called `loadMessages`. Adjust if the original does additional things (e.g. setting up listeners) — the goal is to keep all side effects, just wrap the load with cache-first.

- [ ] **Step 2: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/QueuePage.tsx
git commit -m "perf(frontend): cache-first QueuePage + prefetch next chats"
```

---

## Phase C — Verification & deploy

### Task 11: Final verification + push

- [ ] **Step 1: Backend full suite**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/backend && source .venv/bin/activate && pytest tests/ -v
```
Expected: 101 tests pass (82 prior + 8 cache + 5 since + 2 bootstrap_cache + 4 spa_fallback).

- [ ] **Step 2: Frontend build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build
```
Expected: succeeds.

- [ ] **Step 3: Manual end-to-end (optional, requires real .env on VPS)**

```bash
# 1. Hit /messages/since via curl
curl -s "http://185.252.215.73/messages/since?chat_id=1&since_id=0&limit=5"
# 2. /bootstrap should serve from cache on second call (look at backend log timestamps)
curl -s "http://185.252.215.73/bootstrap" > /dev/null
curl -s "http://185.252.215.73/bootstrap" > /dev/null
# 3. Refresh in browser — http://185.252.215.73/chat/123 should load SPA
```

- [ ] **Step 4: Commit + push**

```bash
git push origin denis-branch
```

- [ ] **Step 5: Deploy**

```bash
./deploy.sh
```
Expected: deploy.sh handles the rebuild + nginx reload. The new `/messages/since` endpoint may need to be added to the nginx allow-list — check after deploy:

```bash
ssh -i ~/.ssh/id_ed25519 root@185.252.215.73 'curl -s http://127.0.0.1/messages/since?chat_id=1\&since_id=0 | head -c 100'
```

If nginx returns the SPA for `/messages/since`, add `messages` is already in the allow-list (it covers `/messages/since` because the regex matches the prefix). Should work without nginx change.

---

## Plan 3 — Definition of Done

- [x] 101 backend tests pass.
- [x] `GET /messages/since?chat_id=&since_id=` returns chronological delta of messages.
- [x] `/bootstrap` is served from a 30s in-memory cache per account.
- [x] FastAPI catch-all returns SPA index.html for unknown paths (defense in depth).
- [x] IndexedDB stores chat history; opening a chat hydrates from cache before any network call.
- [x] WS-incoming messages are persisted to cache (so refresh shows the message without a fetch).
- [x] QueuePage prefetches the next 1-2 chats with a 300ms debounce.
- [x] `npm run build` succeeds.
- [x] No regression in `/auth`, `/me`, `/dialogs`, `/folders`, `/queue`, `/tasks`, `/generate_reply`, `/messages` (existing endpoint).

After this ships, **Plan 4** (snooze + 4-button QueuePage + chip filters + frontend page decomposition) is unblocked. The cache layer Plan 4 components will use is now in place.
