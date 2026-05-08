# Snooze + Tasks + Chip Filters Implementation Plan (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the QueuePage 3-button bar with **Done / Snooze / Task / Skip** (snooze with time picker, Task creates a task tied to the chat). Replace MessagePage tabs (Личные / Группы / Контакты) with multi-select chips and add folder chips for both MessagePage and QueuePage. Persist queue + snooze across backend restarts.

**Architecture:** `QueueService` gains a per-account snoozed map (`{chat_id: until_ts}`) and a `JsonStore`-backed persist layer that survives restarts. A background worker polls every 30s and restores expired snoozes. `/queue/action` adds `action: "snooze"` with `snooze_until`. `/queue?meta=true` includes `snooze_until` per chat. Frontend gets four small reusable components (ChipFilter, SnoozePopup, TaskFromChatForm, QueueActionsBar) and wires them into QueuePage + MessagePage. Full page-level decomposition (extracting QueueHeader/QueueDialogCard/ChatHeader/ChatMessageList) is intentionally deferred — these new components already pull the feature-bearing code out, and a refactor-only PR is safer as a dedicated follow-up.

**Tech Stack:** FastAPI + asyncio (snooze worker), `JsonStore` (existing utility from Plan 1), pytest. React + shadcn/ui chips/popovers; manual smoke for frontend.

**Spec:** `docs/superpowers/specs/2026-05-08-tg-focus-app-redesign-design.md` Phases 6, 7 + persistence ask from §6.

**Out of scope (Plan 5 if needed):** full page-level decomposition (`pages/QueuePage.tsx` 766 LOC → ≤200, `pages/ChatPage.tsx` 627 LOC → ≤250). The components added here pull the new feature code into focused modules; the existing god-page bodies remain.

---

## File Structure (Plan 4)

### Backend — new files

| File | Responsibility |
|---|---|
| `backend/services/snooze_worker.py` | `start_snooze_worker(queue_service, broadcaster)` — background task that calls `queue_service.expire_snoozed(now)` every 30s and broadcasts `queue_update` for restored chats. |
| `backend/tests/test_queue_service_snooze.py` | Unit tests for snooze on `QueueService`. |
| `backend/tests/test_queue_service_persist.py` | Unit tests for queue + snooze persistence round-trip. |
| `backend/tests/test_queue_action_snooze.py` | Integration tests for `/queue/action {action: "snooze"}`. |
| `backend/tests/test_queue_meta_snooze.py` | Integration tests for `?meta=true` returning `snooze_until` per chat. |

### Backend — modified files

| File | Change |
|---|---|
| `backend/services/queue_service.py` | Add `snooze(account, chat_id, until_ts)`, `expire_snoozed(now_ts) -> dict[account, list[chat_id]]`, persist all state via `JsonStore` injected at construction. |
| `backend/routers/queue.py` | `/queue/action` handles `action: "snooze"` (rejects past timestamps); `/queue?meta=true` includes `snooze_until: int | null` per item. |
| `backend/main.py` | Construct `JsonStore` for queue state, pass to `QueueService`; start snooze worker in lifespan. |
| `backend/services/__init__.py` | Re-export `start_snooze_worker`. |

### Frontend — new files

| File | Responsibility |
|---|---|
| `frontend/src/components/ui-extras/ChipFilter.tsx` | Reusable multi-select chip group. |
| `frontend/src/components/queue/SnoozePopup.tsx` | Popover with presets (1ч / 4ч / Завтра 9:00 / Через неделю / Кастом) + custom datetime input. Returns chosen `until_ts`. |
| `frontend/src/components/queue/TaskFromChatForm.tsx` | Inline form with prefilled text + "также убрать из очереди" checkbox. Calls `tasksApi.create({chat_id, chat_title, text})`. |
| `frontend/src/components/queue/QueueActionsBar.tsx` | Four buttons: Done / Snooze / Task / Skip. Snooze opens `SnoozePopup`; Task opens `TaskFromChatForm`. |
| `frontend/src/components/message/ContactsFilter.tsx` | Wrapper around `ChipFilter` for MessagePage: type chips (Личные / Группы / Контакты) + folder chips. Persists to `localStorage`. |
| `frontend/src/components/queue/QueueFolderFilter.tsx` | Wrapper around `ChipFilter` for QueuePage: folder chips only. Persists to `localStorage`. |

### Frontend — modified files

| File | Change |
|---|---|
| `frontend/src/services/telegramApi.ts` | `queueAction(chatId, action, params?)` accepts optional `{snooze_until: number}` payload. |
| `frontend/src/pages/QueuePage.tsx` | Replace existing 3-button block with `<QueueActionsBar>`; add `<QueueFolderFilter>`; on WS `queue_update` with new chats, refresh local list. |
| `frontend/src/pages/MessagePage.tsx` | Replace tab UI with `<ContactsFilter>`; apply multi-select to `currentList`. |
| `frontend/src/contexts/TelegramContext.tsx` | Type `WS event "snooze_resumed"`: bump `queueRevision` so QueuePage refetches. |

---

## Conventions

- **Working directory:** `/Users/den1shh/Documents/growfood/tg_focus_app`. Branch `denis-branch`.
- **Backend tests:** `cd backend && source .venv/bin/activate && pytest tests/ -v`.
- **Frontend build:** `cd frontend && npm run build`.
- **Plan 3 baseline:** 101 backend tests pass.

---

## Phase A — Backend snooze + persist

### Task 1: QueueService.snooze + expire_snoozed (TDD)

**Files:**
- Modify: `backend/services/queue_service.py`
- Create: `backend/tests/test_queue_service_snooze.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_queue_service_snooze.py`**

```python
"""Tests for QueueService snooze + expiry."""
from __future__ import annotations

import pytest

from services.queue_service import QueueService


async def test_snooze_removes_chat_from_queue():
    q = QueueService()
    await q.add("acc1", 1)
    await q.add("acc1", 2)
    await q.snooze("acc1", 1, until_ts=10_000)
    assert await q.get("acc1") == [2]


async def test_snooze_records_until_ts():
    q = QueueService()
    await q.add("acc1", 1)
    await q.snooze("acc1", 1, until_ts=12_345)
    assert await q.snoozed("acc1") == {1: 12_345}


async def test_snooze_chat_not_in_queue_still_records():
    """Snoozing a chat that's not currently in the queue still records it."""
    q = QueueService()
    await q.snooze("acc1", 99, until_ts=12_345)
    assert await q.snoozed("acc1") == {99: 12_345}
    assert await q.get("acc1") == []


async def test_expire_snoozed_returns_due_chats_and_restores_them():
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=100)
    await q.snooze("acc1", 2, until_ts=300)
    expired = await q.expire_snoozed(now_ts=200)
    assert expired == {"acc1": [1]}
    assert await q.get("acc1") == [1]
    assert await q.snoozed("acc1") == {2: 300}


async def test_expire_snoozed_no_due_returns_empty():
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=500)
    assert await q.expire_snoozed(now_ts=100) == {}


async def test_expire_snoozed_handles_multiple_accounts():
    q = QueueService()
    await q.snooze("a", 1, until_ts=100)
    await q.snooze("b", 2, until_ts=100)
    await q.snooze("a", 3, until_ts=500)
    expired = await q.expire_snoozed(now_ts=200)
    assert sorted(expired["a"]) == [1]
    assert sorted(expired["b"]) == [2]
    assert "c" not in expired


async def test_re_add_clears_snooze():
    """Adding a chat normally should clear its snoozed entry."""
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=500)
    await q.add("acc1", 1)
    assert await q.snoozed("acc1") == {}
    assert await q.get("acc1") == [1]


async def test_done_clears_snooze():
    """Marking done on a snoozed chat clears its snooze entry."""
    q = QueueService()
    await q.snooze("acc1", 1, until_ts=500)
    await q.remove("acc1", 1)
    assert await q.snoozed("acc1") == {}
```

- [ ] **Step 2: Run, verify they fail**

```bash
cd backend && source .venv/bin/activate && pytest tests/test_queue_service_snooze.py -v
```
Expected: AttributeError on `snooze`/`snoozed`/`expire_snoozed`.

- [ ] **Step 3: Modify `backend/services/queue_service.py`** — add snooze methods. Read the current file first to confirm structure. Then add to the `QueueService` class:

In `__init__`, add a new dict:
```python
        self._snoozed: dict[str, dict[int, int]] = {}
```

Add methods (place after the existing `replace` and `head`):

```python
    async def snooze(self, account: str, chat_id: int, until_ts: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            # Remove from active queue if present.
            if chat_id in self._set[account]:
                self._set[account].discard(chat_id)
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass
            self._snoozed.setdefault(account, {})[chat_id] = int(until_ts)

    async def snoozed(self, account: str) -> dict[int, int]:
        async with self._lock:
            return dict(self._snoozed.get(account, {}))

    async def expire_snoozed(self, now_ts: int) -> dict[str, list[int]]:
        """Move chats whose snooze has passed back into the queue.

        Returns a dict[account, list[chat_id]] of restored chats per account.
        """
        async with self._lock:
            restored: dict[str, list[int]] = {}
            for account, by_chat in list(self._snoozed.items()):
                due = [cid for cid, ts in by_chat.items() if ts <= now_ts]
                if not due:
                    continue
                self._ensure_account(account)
                for cid in due:
                    by_chat.pop(cid, None)
                    if cid not in self._set[account]:
                        self._set[account].add(cid)
                        self._order[account].append(cid)
                if not by_chat:
                    self._snoozed.pop(account, None)
                restored[account] = due
            return restored
```

Modify the existing `add` and `remove` methods to clear snooze:

```python
    async def add(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id not in self._set[account]:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)
            # Re-adding overrides snooze.
            if account in self._snoozed:
                self._snoozed[account].pop(chat_id, None)
                if not self._snoozed[account]:
                    self._snoozed.pop(account)

    async def remove(self, account: str, chat_id: int) -> None:
        async with self._lock:
            if account in self._set and chat_id in self._set[account]:
                self._set[account].discard(chat_id)
                try:
                    self._order[account].remove(chat_id)
                except ValueError:
                    pass
            if account in self._snoozed:
                self._snoozed[account].pop(chat_id, None)
                if not self._snoozed[account]:
                    self._snoozed.pop(account)
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_queue_service_snooze.py -v
```
Expected: 8 pass.

- [ ] **Step 5: Run full suite** to verify no regression

```bash
pytest tests/ -v
```
Expected: 101 + 8 = 109 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/services/queue_service.py backend/tests/test_queue_service_snooze.py
git commit -m "feat(queue): add snooze/expire_snoozed to QueueService"
```

---

### Task 2: Persist QueueService state to JsonStore (TDD)

**Files:**
- Modify: `backend/services/queue_service.py`
- Create: `backend/tests/test_queue_service_persist.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_queue_service_persist.py`**

```python
"""Tests that QueueService state persists across instances via JsonStore."""
from __future__ import annotations

from pathlib import Path

import pytest

from services.queue_service import QueueService
from services.state_store import JsonStore


@pytest.fixture
def state_path(tmp_state_dir: Path) -> Path:
    return tmp_state_dir / "queue_state.json"


def _make_store(path: Path) -> JsonStore:
    return JsonStore(
        path,
        default_factory=lambda: {"queues": {}, "snoozed": {}},
    )


async def test_queue_persists_across_instances(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.add("acc1", 100)
    await q1.add("acc1", 200)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.get("acc1") == [100, 200]


async def test_snooze_persists_across_instances(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.snooze("acc1", 99, until_ts=12_345)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.snoozed("acc1") == {99: 12_345}


async def test_remove_persists(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.add("acc1", 1)
    await q1.add("acc1", 2)
    await q1.remove("acc1", 1)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.get("acc1") == [2]


async def test_load_default_when_no_file(state_path):
    q = QueueService(store=_make_store(state_path))
    await q.load()
    assert await q.get("acc1") == []
    assert await q.snoozed("acc1") == {}


async def test_in_memory_when_no_store():
    """Without a store, QueueService operates in-memory only."""
    q = QueueService()
    await q.add("acc1", 1)
    assert await q.get("acc1") == [1]


async def test_expire_persists_restored_chats(state_path):
    q1 = QueueService(store=_make_store(state_path))
    await q1.snooze("acc1", 1, until_ts=100)
    await q1.expire_snoozed(now_ts=200)

    q2 = QueueService(store=_make_store(state_path))
    await q2.load()
    assert await q2.get("acc1") == [1]
    assert await q2.snoozed("acc1") == {}
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_queue_service_persist.py -v
```
Expected: TypeError on `QueueService(store=...)` constructor or AttributeError on `.load()`.

- [ ] **Step 3: Modify `backend/services/queue_service.py`** — accept optional `store` and persist all mutations.

Update the imports at top:

```python
from typing import Optional

from services.state_store import JsonStore
```

Update `__init__`:

```python
    def __init__(self, store: Optional[JsonStore] = None) -> None:
        self._order: dict[str, list[int]] = {}
        self._set: dict[str, set[int]] = {}
        self._snoozed: dict[str, dict[int, int]] = {}
        self._lock = asyncio.Lock()
        self._store = store
```

Add `load` method:

```python
    async def load(self) -> None:
        """Load persisted state from disk. Call once at startup if a store is set."""
        if self._store is None:
            return
        data = await self._store.load()
        async with self._lock:
            queues = data.get("queues", {})
            snoozed = data.get("snoozed", {})
            self._order = {k: list(v) for k, v in queues.items()}
            self._set = {k: set(v) for k, v in queues.items()}
            self._snoozed = {
                k: {int(cid): int(ts) for cid, ts in by_chat.items()}
                for k, by_chat in snoozed.items()
            }
```

Add a private `_persist_unlocked` helper:

```python
    def _persist_unlocked(self) -> dict:
        return {
            "queues": {k: list(v) for k, v in self._order.items()},
            "snoozed": {
                k: {str(cid): ts for cid, ts in by_chat.items()}
                for k, by_chat in self._snoozed.items()
            },
        }

    async def _save(self) -> None:
        if self._store is None:
            return
        data = self._persist_unlocked()
        await self._store.save(data)
```

Update every mutation (`add`, `remove`, `move_to_end`, `replace`, `snooze`, `expire_snoozed`) to call `await self._save()` after the lock is released. Pattern:

```python
    async def add(self, account: str, chat_id: int) -> None:
        async with self._lock:
            self._ensure_account(account)
            if chat_id not in self._set[account]:
                self._set[account].add(chat_id)
                self._order[account].append(chat_id)
            if account in self._snoozed:
                self._snoozed[account].pop(chat_id, None)
                if not self._snoozed[account]:
                    self._snoozed.pop(account)
        await self._save()
```

Same pattern for `remove`, `move_to_end`, `replace`, `snooze`. For `expire_snoozed`, save before returning:

```python
    async def expire_snoozed(self, now_ts: int) -> dict[str, list[int]]:
        async with self._lock:
            restored: dict[str, list[int]] = {}
            for account, by_chat in list(self._snoozed.items()):
                due = [cid for cid, ts in by_chat.items() if ts <= now_ts]
                if not due:
                    continue
                self._ensure_account(account)
                for cid in due:
                    by_chat.pop(cid, None)
                    if cid not in self._set[account]:
                        self._set[account].add(cid)
                        self._order[account].append(cid)
                if not by_chat:
                    self._snoozed.pop(account, None)
                restored[account] = due
        if restored:
            await self._save()
        return restored
```

> **Note:** `_save` runs OUTSIDE the lock. The state read via `_persist_unlocked` happens INSIDE the lock and produces a snapshot before the lock releases. This avoids holding the lock during disk I/O. The cost: a second `_save` from another mutation can race-overwrite. JsonStore's atomic-rename guarantees no partial writes, and last-writer-wins is acceptable here.

> **Lock ordering correction:** the snapshot must be made INSIDE the lock. Update `_save`:

```python
    async def _save(self) -> None:
        if self._store is None:
            return
        async with self._lock:
            data = self._persist_unlocked()
        await self._store.save(data)
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_queue_service_persist.py -v
```
Expected: 6 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 109 + 6 = 115 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/services/queue_service.py backend/tests/test_queue_service_persist.py
git commit -m "feat(queue): persist queue + snooze state via JsonStore"
```

---

### Task 3: /queue/action accepts snooze (TDD)

**Files:**
- Modify: `backend/routers/queue.py`
- Create: `backend/tests/test_queue_action_snooze.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_queue_action_snooze.py`**

```python
"""Integration tests for /queue/action with action='snooze'."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_service import QueueService


class _FakeFolderService:
    async def get_folders(self, account: str = ""):
        return {"folders": [], "chat_to_folders": {}}


@pytest.fixture
def app_factory():
    async def _build(chat_ids: list[int]):
        app = FastAPI()
        qs = QueueService()
        for cid in chat_ids:
            await qs.add("", cid)
        manager = MagicMock()
        manager.get_or_create = MagicMock(return_value=MagicMock())
        manager.default = MagicMock()
        manager.ensure_connected = AsyncMock()
        auth = MagicMock()
        auth.get_authorized_client = AsyncMock(return_value=MagicMock())
        app.include_router(make_router(manager, auth, qs, _FakeFolderService()))
        return app, qs

    return _build


async def test_snooze_action_removes_from_queue(app_factory):
    app, qs = await app_factory([1, 2, 3])
    client = TestClient(app)
    r = client.post(
        "/queue/action",
        json={"chat_id": 1, "action": "snooze", "snooze_until": 9999999999},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert 1 not in body["queue"]
    assert await qs.snoozed("") == {1: 9999999999}


async def test_snooze_rejects_past_timestamp(app_factory):
    app, qs = await app_factory([1])
    client = TestClient(app)
    r = client.post(
        "/queue/action",
        json={"chat_id": 1, "action": "snooze", "snooze_until": 1},
    )
    assert r.status_code == 400


async def test_snooze_requires_until_ts(app_factory):
    app, qs = await app_factory([1])
    client = TestClient(app)
    r = client.post("/queue/action", json={"chat_id": 1, "action": "snooze"})
    assert r.status_code == 400
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_queue_action_snooze.py -v
```
Expected: 400 because action is not in the allow-set, OR 200 with wrong shape.

- [ ] **Step 3: Modify `backend/routers/queue.py`**

Find the `queue_action` handler. Replace it with:

```python
    @router.post("/queue/action")
    async def queue_action(payload: dict[str, Any]):
        import time

        chat_id = payload.get("chat_id")
        action = str(payload.get("action", "")).lower()
        valid = {"done", "postpone", "task", "snooze", "skip"}
        if chat_id is None or action not in valid:
            raise HTTPException(status_code=400, detail="chat_id and valid action are required")

        account = str(payload.get("account", "")).strip()

        if action == "done":
            try:
                client = manager.get_or_create(account) if account else manager.default
                await manager.ensure_connected(client)
                await client.read_chat_history(chat_id)
            except Exception:
                logger.warning("read_chat_history failed", exc_info=True)
            await queue_service.remove(account, chat_id)
        elif action == "snooze":
            until_raw = payload.get("snooze_until")
            if until_raw is None:
                raise HTTPException(status_code=400, detail="snooze_until is required")
            try:
                until_ts = int(until_raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="snooze_until must be int")
            if until_ts <= int(time.time()):
                raise HTTPException(status_code=400, detail="snooze_until must be in the future")
            await queue_service.snooze(account, chat_id, until_ts=until_ts)
        else:
            # postpone / task / skip — all move to end without changing unread
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_queue_action_snooze.py -v
```
Expected: 3 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 115 + 3 = 118 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/queue.py backend/tests/test_queue_action_snooze.py
git commit -m "feat(queue): /queue/action supports snooze with future-only timestamps"
```

---

### Task 4: /queue?meta=true returns snooze_until (TDD)

**Files:**
- Modify: `backend/routers/queue.py`
- Create: `backend/tests/test_queue_meta_snooze.py`

The current `?meta=true` returns `{chat_id, folder_ids}`. Add `snooze_until: int | null`.

- [ ] **Step 1: Write failing tests `backend/tests/test_queue_meta_snooze.py`**

```python
"""Tests that /queue?meta=true returns snooze_until per item."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_service import QueueService


class _FakeFolderService:
    async def get_folders(self, account: str = ""):
        return {"folders": [], "chat_to_folders": {}}


@pytest.fixture
def app_factory():
    async def _build(chat_ids: list[int], snoozed: dict[int, int]):
        app = FastAPI()
        qs = QueueService()
        for cid in chat_ids:
            await qs.add("", cid)
        for cid, ts in snoozed.items():
            await qs.snooze("", cid, until_ts=ts)
        manager = MagicMock()
        manager.get_or_create = MagicMock(return_value=MagicMock())
        manager.default = MagicMock()
        manager.ensure_connected = AsyncMock()
        auth = MagicMock()
        auth.get_authorized_client = AsyncMock(return_value=MagicMock())
        app.include_router(make_router(manager, auth, qs, _FakeFolderService()))
        return app, qs

    return _build


async def test_meta_includes_snooze_until_null_for_active(app_factory):
    app, _ = await app_factory([1, 2], {})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    body = r.json()
    assert body["queue"] == [
        {"chat_id": 1, "folder_ids": [], "snooze_until": None},
        {"chat_id": 2, "folder_ids": [], "snooze_until": None},
    ]


async def test_meta_excludes_snoozed_chats_from_active_queue(app_factory):
    app, _ = await app_factory([1, 2], {3: 9999999999})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    body = r.json()
    # Snoozed chats are NOT in the active queue list.
    chat_ids = [item["chat_id"] for item in body["queue"]]
    assert 3 not in chat_ids
    assert chat_ids == [1, 2]


async def test_meta_includes_snoozed_section(app_factory):
    """The meta payload must expose snoozed entries so the UI can render them."""
    app, _ = await app_factory([1], {3: 9999999999, 5: 9999999998})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    body = r.json()
    snoozed = {entry["chat_id"]: entry["snooze_until"] for entry in body["snoozed"]}
    assert snoozed == {3: 9999999999, 5: 9999999998}


async def test_default_queue_endpoint_unchanged(app_factory):
    """No meta=true → unchanged shape."""
    app, _ = await app_factory([1], {3: 9999999999})
    client = TestClient(app)
    r = client.get("/queue")
    assert r.json() == {"queue": [1]}
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_queue_meta_snooze.py -v
```
Expected: failures (no `snooze_until` field, no `snoozed` section).

- [ ] **Step 3: Modify `backend/routers/queue.py`** — extend `get_queue`:

Replace the existing `get_queue` with:

```python
    @router.get("/queue")
    async def get_queue(account: str = "", meta: bool = False):
        order = await queue_service.get(account)
        if not meta:
            return {"queue": order}

        try:
            payload = await folder_service.get_folders(account=account)
        except Exception:
            logger.warning("FolderService.get_folders failed", exc_info=True)
            payload = {"chat_to_folders": {}}
        c2f = payload.get("chat_to_folders", {})
        snoozed = await queue_service.snoozed(account)
        return {
            "queue": [
                {
                    "chat_id": cid,
                    "folder_ids": list(c2f.get(cid, [])),
                    "snooze_until": None,
                }
                for cid in order
            ],
            "snoozed": [
                {"chat_id": cid, "snooze_until": ts}
                for cid, ts in sorted(snoozed.items(), key=lambda kv: kv[1])
            ],
        }
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_queue_meta_snooze.py -v
```
Expected: 4 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 122 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/queue.py backend/tests/test_queue_meta_snooze.py
git commit -m "feat(queue): /queue?meta=true includes snooze_until and snoozed list"
```

---

### Task 5: Snooze worker + main.py wiring

**Files:**
- Create: `backend/services/snooze_worker.py`
- Modify: `backend/main.py`
- Modify: `backend/services/__init__.py`

- [ ] **Step 1: Create `backend/services/snooze_worker.py`**

```python
"""Background worker that restores snoozed chats when their snooze expires."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

CHECK_INTERVAL_SECONDS = 30


async def _tick(queue_service: QueueService, broadcaster: Broadcaster) -> None:
    now = int(time.time())
    try:
        restored = await queue_service.expire_snoozed(now_ts=now)
    except Exception:
        logger.warning("expire_snoozed failed", exc_info=True)
        return
    for account, chat_ids in restored.items():
        for chat_id in chat_ids:
            event: dict[str, Any] = {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "reason": "snooze_resumed",
            }
            try:
                await broadcaster.broadcast(event)
            except Exception:
                logger.warning("broadcast snooze_resumed failed", exc_info=True)


def start_snooze_worker(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    *,
    interval_seconds: int = CHECK_INTERVAL_SECONDS,
) -> asyncio.Task:
    """Start the worker as a background task. Cancel the returned Task to stop."""

    async def _run() -> None:
        while True:
            await _tick(queue_service, broadcaster)
            await asyncio.sleep(interval_seconds)

    return asyncio.create_task(_run())
```

- [ ] **Step 2: Update `backend/services/__init__.py`** — add `start_snooze_worker` to exports:

Read the current file and add:
```python
from services.snooze_worker import start_snooze_worker
```
Then append `"start_snooze_worker"` to `__all__`.

- [ ] **Step 3: Modify `backend/main.py`**

Find `create_app()`. Construct a `JsonStore` for queue state and pass to `QueueService`. Find the line where `queue_service = QueueService()` is. Replace with:

```python
    queue_state_store = JsonStore(
        cfg.session_dir / "queue_state.json",
        default_factory=lambda: {"queues": {}, "snoozed": {}},
    )
    queue_service = QueueService(store=queue_state_store)
```

Find the lifespan function. Replace it to load state at startup and start the worker:

```python
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await queue_service.load()
        worker = start_snooze_worker(queue_service, broadcaster)
        try:
            yield
        finally:
            worker.cancel()
            try:
                await worker
            except (asyncio.CancelledError, Exception):
                pass
            await manager.stop_all()
            if claude_client is not None:
                try:
                    await claude_client.aclose()
                except Exception:
                    logger.warning("claude_client.aclose() failed", exc_info=True)
```

Add the import at the top:
```python
import asyncio
from services.snooze_worker import start_snooze_worker
```

- [ ] **Step 4: Run full suite**

```bash
cd backend && source .venv/bin/activate && pytest tests/ -v
```
Expected: 122 pass (smoke test still imports app cleanly).

- [ ] **Step 5: Commit**

```bash
git add backend/services/snooze_worker.py backend/services/__init__.py backend/main.py
git commit -m "feat(queue): start snooze worker and persist queue state across restarts"
```

---

## Phase B — Frontend chip filters

### Task 6: ChipFilter reusable component

**Files:**
- Create: `frontend/src/components/ui-extras/ChipFilter.tsx`

This component is used by both MessagePage and QueuePage. Multi-select; click toggles; visual: filled when selected, outline when not.

- [ ] **Step 1: Inspect existing UI conventions**

```bash
ls /Users/den1shh/Documents/growfood/tg_focus_app/frontend/src/components/ui | head -10
```
Expected: shadcn/ui components like `button.tsx`, `badge.tsx`. We use Tailwind classes.

- [ ] **Step 2: Create `frontend/src/components/ui-extras/ChipFilter.tsx`**

```tsx
import { cn } from "@/lib/utils";

export type ChipOption = {
  id: string;
  label: string;
  count?: number;
};

type Props = {
  options: ChipOption[];
  selected: string[];
  onToggle: (id: string) => void;
  className?: string;
};

/**
 * Multi-select chip group. Empty `selected` means "no filter applied"
 * (caller should treat empty as "show everything"). Clicking a chip toggles
 * it in the selected set.
 */
export function ChipFilter({ options, selected, onToggle, className }: Props) {
  if (options.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {options.map((opt) => {
        const active = selected.includes(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onToggle(opt.id)}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium transition-colors border",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted",
            )}
            aria-pressed={active}
          >
            {opt.label}
            {opt.count != null && (
              <span className="ml-1 opacity-60 tabular-nums">({opt.count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui-extras/ChipFilter.tsx
git commit -m "feat(frontend): add reusable ChipFilter multi-select component"
```

---

### Task 7: ContactsFilter — replace MessagePage tabs

**Files:**
- Create: `frontend/src/components/message/ContactsFilter.tsx`
- Modify: `frontend/src/pages/MessagePage.tsx`

Two chip groups: type (private/groups/contacts) + folders (from `useFolders`). Multi-select; persists to localStorage.

- [ ] **Step 1: Create `frontend/src/components/message/ContactsFilter.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "message_filter";

type Persisted = { types: string[]; folders: string[] };

const TYPE_OPTIONS: ChipOption[] = [
  { id: "private", label: "Личные" },
  { id: "groups", label: "Группы" },
  { id: "contacts", label: "Контакты" },
];

export type FilterState = {
  types: string[];
  folderIds: number[];
};

type Props = {
  /** Counts shown next to type chips. Optional. */
  typeCounts?: Partial<Record<"private" | "groups" | "contacts", number>>;
  onChange: (state: FilterState) => void;
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { types: [], folders: [] };
    const parsed = JSON.parse(raw);
    return {
      types: Array.isArray(parsed.types) ? parsed.types : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
    };
  } catch {
    return { types: [], folders: [] };
  }
}

function savePersisted(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* best-effort */
  }
}

export function ContactsFilter({ typeCounts, onChange }: Props) {
  const persisted = useMemo(loadPersisted, []);
  const [types, setTypes] = useState<string[]>(persisted.types);
  const [folderIds, setFolderIds] = useState<string[]>(persisted.folders);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted({ types, folders: folderIds });
    onChange({
      types,
      folderIds: folderIds
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n)),
    });
  }, [types, folderIds, onChange]);

  const toggleType = (id: string) =>
    setTypes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleFolder = (id: string) =>
    setFolderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const typeOptionsWithCounts: ChipOption[] = TYPE_OPTIONS.map((opt) => ({
    ...opt,
    count: typeCounts?.[opt.id as "private" | "groups" | "contacts"],
  }));

  const folderOptions: ChipOption[] = folders.map((f) => ({
    id: String(f.id),
    label: f.title,
  }));

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-border">
      <ChipFilter options={typeOptionsWithCounts} selected={types} onToggle={toggleType} />
      {!isLoading && folderOptions.length > 0 && (
        <ChipFilter options={folderOptions} selected={folderIds} onToggle={toggleFolder} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Modify `frontend/src/pages/MessagePage.tsx`**

Read the current file. Find the existing tab UI (`<button onClick={() => setTab('private')} ...>`). Replace the tab block + the `currentList` derivation with chip-filter-driven logic.

Add imports:
```typescript
import { ContactsFilter, type FilterState } from "@/components/message/ContactsFilter";
import { useFolders } from "@/hooks/useFolders";
```

Inside the component, replace the existing `tab` state and tab buttons with filter state:

```typescript
  const [filter, setFilter] = useState<FilterState>({ types: [], folderIds: [] });
  const { chatToFolders } = useFolders();
```

Remove the `tab` state, the three `<button onClick={() => setTab(...)}>` blocks, and the `currentList = tab === ... ? ... : ...` ternary.

Replace `currentList` derivation:

```typescript
  const allItems: ListItem[] = useMemo(() => {
    const items: ListItem[] = [];
    if (filter.types.length === 0 || filter.types.includes("private")) {
      items.push(
        ...state.chats
          .filter((c) => c.type === "private")
          .map((c) => ({ id: c.id, name: c.title, lastMessage: c.lastMessage?.text, type: c.type })),
      );
    }
    if (filter.types.length === 0 || filter.types.includes("groups")) {
      items.push(
        ...state.chats
          .filter((c) => c.type === "group" || c.type === "supergroup")
          .map((c) => ({ id: c.id, name: c.title, lastMessage: c.lastMessage?.text, type: c.type })),
      );
    }
    if (filter.types.length === 0 || filter.types.includes("contacts")) {
      items.push(
        ...(state.contacts || []).map((c) => ({ id: c.id, name: c.title, type: "private" as const })),
      );
    }
    return items;
  }, [state.chats, state.contacts, filter.types]);

  const filtered = useMemo(() => {
    let list = allItems;
    if (filter.folderIds.length > 0) {
      list = list.filter((item) => {
        const folders = chatToFolders.get(item.id) ?? [];
        return folders.some((id) => filter.folderIds.includes(id));
      });
    }
    return list.filter((item) =>
      item.name.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [allItems, filter.folderIds, chatToFolders, searchQuery]);
```

Add `<ContactsFilter>` to the JSX between the search input and the list:

```tsx
      <ContactsFilter
        typeCounts={{
          private: state.chats.filter((c) => c.type === "private").length,
          groups: state.chats.filter((c) => c.type === "group" || c.type === "supergroup").length,
          contacts: (state.contacts || []).length,
        }}
        onChange={setFilter}
      />
```

Remove the entire existing "Tabs" `<div className="flex border-b border-border">` block.

- [ ] **Step 3: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/message/ContactsFilter.tsx frontend/src/pages/MessagePage.tsx
git commit -m "feat(frontend): replace MessagePage tabs with multi-select chips + folder filter"
```

---

### Task 8: QueueFolderFilter — folder chips on QueuePage

**Files:**
- Create: `frontend/src/components/queue/QueueFolderFilter.tsx`
- Modify: `frontend/src/pages/QueuePage.tsx`

Folder-only chip filter. When non-empty, hides queue chats that aren't in any selected folder. Persists to localStorage.

- [ ] **Step 1: Create `frontend/src/components/queue/QueueFolderFilter.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "queue_folder_filter";

function loadPersisted(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function savePersisted(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* best-effort */
  }
}

type Props = {
  onChange: (folderIds: number[]) => void;
};

export function QueueFolderFilter({ onChange }: Props) {
  const persisted = useMemo(loadPersisted, []);
  const [selected, setSelected] = useState<string[]>(persisted);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted(selected);
    onChange(
      selected.map((s) => Number(s)).filter((n) => Number.isFinite(n)),
    );
  }, [selected, onChange]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (isLoading || folders.length === 0) return null;

  const options: ChipOption[] = folders.map((f) => ({
    id: String(f.id),
    label: f.title,
  }));

  return (
    <div className="px-4 py-2 border-b border-border">
      <ChipFilter options={options} selected={selected} onToggle={toggle} />
    </div>
  );
}
```

- [ ] **Step 2: Modify `frontend/src/pages/QueuePage.tsx`**

Add import:
```typescript
import { QueueFolderFilter } from "@/components/queue/QueueFolderFilter";
```

Inside the component, near the existing `useFolders` usage, add:
```typescript
  const [folderFilter, setFolderFilter] = useState<number[]>([]);
```

Find the line where `queueIds` becomes `currentChatId` (e.g. `const currentChatId = queueIds[currentIndex];`). Compute a filtered queue first:

```typescript
  const visibleQueueIds = useMemo(() => {
    if (folderFilter.length === 0) return queueIds;
    return queueIds.filter((cid) => {
      const folders = chatToFolders.get(cid) ?? [];
      return folders.some((id) => folderFilter.includes(id));
    });
  }, [queueIds, folderFilter, chatToFolders]);
```

Replace `queueIds[currentIndex]` references with `visibleQueueIds[currentIndex]`. Specifically:
- `const currentChatId = queueIds[currentIndex];` → `const currentChatId = visibleQueueIds[currentIndex];`
- `usePrefetchQueue(queueIds, currentIndex);` → `usePrefetchQueue(visibleQueueIds, currentIndex);`
- The header counter `queueIds.length` references → keep as-is OR also update; show both numbers if you like.

Render the filter component near the top of the JSX, after the header block:

```tsx
      <QueueFolderFilter onChange={setFolderFilter} />
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/queue/QueueFolderFilter.tsx frontend/src/pages/QueuePage.tsx
git commit -m "feat(frontend): add folder chip filter to QueuePage"
```

---

## Phase C — Frontend snooze + task UX

### Task 9: SnoozePopup component

**Files:**
- Create: `frontend/src/components/queue/SnoozePopup.tsx`

Compact dialog with five preset buttons + a custom datetime input. Returns chosen `until_ts` (unix seconds) via callback. Closes on selection or backdrop click.

- [ ] **Step 1: Create `frontend/src/components/queue/SnoozePopup.tsx`**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";

const HOUR = 3600;
const DAY = 86400;

type Props = {
  open: boolean;
  onClose: () => void;
  onSnooze: (untilTs: number) => void;
};

function nextMorningAt9(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function inOneWeek(): number {
  return Math.floor(Date.now() / 1000) + 7 * DAY;
}

const PRESETS = [
  { id: "1h", label: "1 час", offsetSeconds: HOUR },
  { id: "4h", label: "4 часа", offsetSeconds: 4 * HOUR },
] as const;

export function SnoozePopup({ open, onClose, onSnooze }: Props) {
  const [custom, setCustom] = useState<string>("");

  if (!open) return null;

  const choosePreset = (offsetSeconds: number) => {
    onSnooze(Math.floor(Date.now() / 1000) + offsetSeconds);
    onClose();
  };

  const submitCustom = () => {
    if (!custom) return;
    const ms = new Date(custom).getTime();
    if (!Number.isFinite(ms)) return;
    const ts = Math.floor(ms / 1000);
    if (ts <= Math.floor(Date.now() / 1000)) return;
    onSnooze(ts);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-lg max-w-sm w-full p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold">Отложить чат</h3>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="outline"
              size="sm"
              onClick={() => choosePreset(p.offsetSeconds)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onSnooze(nextMorningAt9());
              onClose();
            }}
          >
            Завтра 9:00
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onSnooze(inOneWeek());
              onClose();
            }}
          >
            Через неделю
          </Button>
        </div>
        <div className="flex flex-col gap-2 pt-2 border-t border-border">
          <label className="text-xs text-muted-foreground">Кастомное время:</label>
          <div className="flex gap-2">
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="flex-1 text-sm px-2 py-1 rounded border border-border bg-background"
            />
            <Button size="sm" onClick={submitCustom} disabled={!custom}>
              Отложить
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/queue/SnoozePopup.tsx
git commit -m "feat(frontend): add SnoozePopup with 4 presets and custom datetime"
```

---

### Task 10: TaskFromChatForm component

**Files:**
- Create: `frontend/src/components/queue/TaskFromChatForm.tsx`

Inline form: prefilled text "Ответить {chat_title}", checkbox "также убрать из очереди". On submit calls `tasksApi.create({chat_id, chat_title, text})` and (if checkbox) `telegramApi.queueAction(chat_id, 'done')`.

- [ ] **Step 1: Create `frontend/src/components/queue/TaskFromChatForm.tsx`**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tasksApi } from "@/services/tasksApi";
import { toast } from "sonner";

type Props = {
  open: boolean;
  chatId: number;
  chatTitle: string;
  onClose: () => void;
  /** Called after successful task creation. The boolean indicates whether
   * the user requested also-remove-from-queue. */
  onCreated: (alsoRemove: boolean) => void;
};

export function TaskFromChatForm({ open, chatId, chatTitle, onClose, onCreated }: Props) {
  const [text, setText] = useState<string>(`Ответить ${chatTitle}`);
  const [alsoRemove, setAlsoRemove] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  if (!open) return null;

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await tasksApi.create({
        text: trimmed,
        chat_id: chatId,
        chat_title: chatTitle,
      });
      toast.success("Задача создана");
      onCreated(alsoRemove);
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Не удалось создать задачу");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-lg max-w-md w-full p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold">Новая задача</h3>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          placeholder="Текст задачи..."
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={alsoRemove}
            onChange={(e) => setAlsoRemove(e.target.checked)}
          />
          Также убрать из очереди
        </label>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          <Button size="sm" onClick={submit} disabled={submitting || !text.trim()}>
            {submitting ? "..." : "Создать"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/queue/TaskFromChatForm.tsx
git commit -m "feat(frontend): add TaskFromChatForm component"
```

---

### Task 11: QueueActionsBar — 4 buttons + wire into QueuePage

**Files:**
- Create: `frontend/src/components/queue/QueueActionsBar.tsx`
- Modify: `frontend/src/services/telegramApi.ts`
- Modify: `frontend/src/pages/QueuePage.tsx`

- [ ] **Step 1: Modify `telegramApi.ts` — `queueAction` accepts optional payload extras**

Read `frontend/src/services/telegramApi.ts`. Find `queueAction` (likely currently signature `(chatId, action) => Promise<...>`). Replace with:

```typescript
  async queueAction(
    chatId: number,
    action: "done" | "postpone" | "task" | "snooze" | "skip",
    extra: { snooze_until?: number } = {},
  ): Promise<number[]> {
    if (!this.isAuthenticated) throw new Error("Пользователь не авторизован");
    const path = this.withAccountQuery("/queue/action");
    const body: any = { chat_id: chatId, action, ...extra };
    const res = await this.fetchJson(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return Array.isArray(res?.queue) ? res.queue : [];
  }
```

> **Note:** check the existing return shape — the existing method may return `{queue, next_chat_id}` or just `number[]`. Adjust the return type to match what callers expect. Read all callers (`grep -n "queueAction" src/`) and keep the same shape.

- [ ] **Step 2: Create `frontend/src/components/queue/QueueActionsBar.tsx`**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Clock, ListTodo, SkipForward } from "lucide-react";
import { SnoozePopup } from "./SnoozePopup";
import { TaskFromChatForm } from "./TaskFromChatForm";

type Props = {
  chatId: number;
  chatTitle: string;
  onDone: () => void;
  onSnooze: (untilTs: number) => void;
  onSkip: () => void;
  /** Called after task was created. alsoRemove=true → also call onDone(). */
  onTaskCreated: (alsoRemove: boolean) => void;
};

export function QueueActionsBar({
  chatId,
  chatTitle,
  onDone,
  onSnooze,
  onSkip,
  onTaskCreated,
}: Props) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  return (
    <>
      <div className="grid grid-cols-4 gap-2 p-3 border-t border-border">
        <Button variant="default" onClick={onDone}>
          <Check className="h-4 w-4 mr-1" />
          Готово
        </Button>
        <Button variant="outline" onClick={() => setSnoozeOpen(true)}>
          <Clock className="h-4 w-4 mr-1" />
          Отложить
        </Button>
        <Button variant="outline" onClick={() => setTaskOpen(true)}>
          <ListTodo className="h-4 w-4 mr-1" />
          В задачи
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          <SkipForward className="h-4 w-4 mr-1" />
          Пропустить
        </Button>
      </div>

      <SnoozePopup
        open={snoozeOpen}
        onClose={() => setSnoozeOpen(false)}
        onSnooze={onSnooze}
      />
      <TaskFromChatForm
        open={taskOpen}
        chatId={chatId}
        chatTitle={chatTitle}
        onClose={() => setTaskOpen(false)}
        onCreated={onTaskCreated}
      />
    </>
  );
}
```

- [ ] **Step 3: Wire into `frontend/src/pages/QueuePage.tsx`**

Find the existing 3-button block (Done / Delay / Task buttons). Read the current `handleAction` function. Replace its `done | delay | task` mapping with calls that match the new actions. Then replace the entire button JSX block with `<QueueActionsBar>`.

Add import:
```typescript
import { QueueActionsBar } from "@/components/queue/QueueActionsBar";
```

Add handler functions inside the component:

```typescript
  const handleDone = async () => {
    if (!currentChatId) return;
    try {
      await telegramApi.queueAction(currentChatId, "done");
      // After done, remove from local queue and advance.
      setQueueIds((prev) => prev.filter((id) => id !== currentChatId));
      dispatch({ type: "QUEUE_DIRTY" });
    } catch (e) {
      console.warn("done failed", e);
    }
  };

  const handleSnooze = async (untilTs: number) => {
    if (!currentChatId) return;
    try {
      await telegramApi.queueAction(currentChatId, "snooze", { snooze_until: untilTs });
      setQueueIds((prev) => prev.filter((id) => id !== currentChatId));
      dispatch({ type: "QUEUE_DIRTY" });
    } catch (e) {
      console.warn("snooze failed", e);
    }
  };

  const handleSkip = async () => {
    if (!currentChatId) return;
    try {
      const newQueue = await telegramApi.queueAction(currentChatId, "skip");
      setQueueIds(newQueue);
      setCurrentIndex((i) => Math.min(i, Math.max(0, newQueue.length - 1)));
      dispatch({ type: "QUEUE_DIRTY" });
    } catch (e) {
      console.warn("skip failed", e);
    }
  };

  const handleTaskCreated = async (alsoRemove: boolean) => {
    if (alsoRemove) {
      await handleDone();
    }
  };
```

Replace the old action JSX (find `{/* Action Buttons */}` block or the three `<Button onClick={() => handleAction(...)}>` calls) with:

```tsx
      <QueueActionsBar
        chatId={currentChatId ?? 0}
        chatTitle={currentDialog?.name ?? ""}
        onDone={handleDone}
        onSnooze={handleSnooze}
        onSkip={handleSkip}
        onTaskCreated={handleTaskCreated}
      />
```

> **Note:** the old `handleAction("done" | "delay" | "task")` is replaced. If any other code path inside the file calls `handleAction`, update those call sites too. The action-bar only renders when `currentDialog` is defined — so the `?? 0` guard is mostly defensive.

- [ ] **Step 4: Verify build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/telegramApi.ts frontend/src/components/queue/QueueActionsBar.tsx frontend/src/pages/QueuePage.tsx
git commit -m "feat(frontend): 4-button QueueActionsBar with snooze + task popups"
```

---

### Task 12: WS handler reacts to snooze_resumed

**Files:**
- Modify: `frontend/src/contexts/TelegramContext.tsx`

The backend snooze worker emits `{type: "queue_update", reason: "snooze_resumed", chat_id, account}`. The existing context already handles `queue_update` by bumping `queueRevision`. We just need to ensure the bump happens (it does) — verify by reading current code. If the existing handler already increments `queueRevision` for ALL `queue_update` events (regardless of reason), no change is needed.

- [ ] **Step 1: Inspect existing `onWsEvent`**

```bash
grep -n "queue_update\|QUEUE_DIRTY\|queueRevision" /Users/den1shh/Documents/growfood/tg_focus_app/frontend/src/contexts/TelegramContext.tsx
```

If you see a branch like:
```typescript
if (evt?.type === "queue_update" && typeof evt.chat_id === "number") {
  dispatch({ type: "INCOMING", payload: { chatId: evt.chat_id, at: Date.now() } });
  dispatch({ type: "QUEUE_DIRTY" });
}
```
…the bump already fires for snooze_resumed. No change needed.

If the handler is more restrictive (e.g. requires a specific reason field), add a `|| evt?.reason === "snooze_resumed"` clause.

- [ ] **Step 2: If unchanged, skip the commit. Otherwise commit:**

```bash
git add frontend/src/contexts/TelegramContext.tsx
git commit -m "feat(frontend): handle snooze_resumed WS event"
```

If no change was needed, document by running:
```bash
echo "WS already bumps queueRevision on all queue_update events — snooze_resumed handled implicitly."
```

---

## Phase D — Verification & deploy

### Task 13: Final verify + deploy

- [ ] **Step 1: Backend full suite**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/backend && source .venv/bin/activate && pytest tests/ -v
```
Expected: 122 tests pass (101 baseline + 8 snooze + 6 persist + 3 action_snooze + 4 meta_snooze).

- [ ] **Step 2: Frontend build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build
```
Expected: succeeds.

- [ ] **Step 3: Manual end-to-end (optional, requires real .env on VPS)**

```bash
# 1. Snooze a chat (replace CHAT_ID with a real chat id)
curl -s -X POST http://185.252.215.73/queue/action \
  -H "Content-Type: application/json" \
  -d '{"chat_id":CHAT_ID, "action":"snooze", "snooze_until":'"$(($(date +%s) + 60))"'}'

# 2. Verify it's not in /queue
curl -s "http://185.252.215.73/queue?meta=true"

# 3. Wait 60 seconds + 30s for the worker tick. Check again.
sleep 95
curl -s "http://185.252.215.73/queue?meta=true"
# Chat should reappear.

# 4. Create a task tied to a chat
curl -s -X POST http://185.252.215.73/tasks \
  -H "Content-Type: application/json" \
  -d '{"text":"e2e", "chat_id":CHAT_ID, "chat_title":"E2E Test"}'

curl -s http://185.252.215.73/tasks
```

- [ ] **Step 4: Push + deploy**

```bash
git push origin denis-branch
./deploy.sh
```

---

## Plan 4 — Definition of Done

- [x] 122 backend tests pass.
- [x] `QueueService` has `snooze`, `snoozed`, `expire_snoozed` methods backed by `JsonStore`.
- [x] Queue + snooze state survives backend restart.
- [x] Background worker restores snoozed chats every 30s and broadcasts `queue_update {reason: "snooze_resumed"}`.
- [x] `/queue/action` accepts `action: "snooze"` with future-only `snooze_until`.
- [x] `/queue?meta=true` returns `snooze_until` per active item and a `snoozed` array.
- [x] MessagePage uses chip filters (types + folders) instead of tabs.
- [x] QueuePage shows a folder chip filter.
- [x] QueuePage 4 buttons: Done / Snooze / Task / Skip; Snooze opens preset popup; Task opens inline form.
- [x] Tasks created via QueuePage carry `chat_id` and `chat_title`; appear in TodoPage as clickable plashka.
- [x] Frontend builds; nginx + deploy.sh apply changes cleanly.

After this ships, the 7 user-requested items from the spec are all done. Frontend page-decomposition (`QueuePage.tsx` 766→200 LOC, `ChatPage.tsx` 627→250 LOC, `TelegramContext.tsx` extracting `useTelegramSocket`) becomes a pure refactoring follow-up if and when the file size becomes a maintenance concern.
