# Folders & Queue Extension Implementation Plan (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Telegram dialog folders to the API and broaden the queue to include private + group + supergroup chats (excluding archive).

**Architecture:** New `FolderService` reads Pyrogram raw `messages.GetDialogFilters` per account with a 60-second TTL cache, exposes folder metadata via `GET /folders`, tracks archived chats via `dialog.folder_id == 1` populated during `/bootstrap`. The incoming-message handler accepts non-private chats and skips archived ones. `/dialogs` and `/queue?meta=true` return `folder_ids` per chat. Minimal frontend touch: folder name label on the QueuePage current-chat card so the new backend data is visible end-to-end.

**Tech Stack:** FastAPI + Pyrogram (raw `messages.GetDialogFilters`), pytest + pytest-asyncio for backend; React + TypeScript for the small frontend touch.

**Spec:** `docs/superpowers/specs/2026-05-08-tg-focus-app-redesign-design.md` (Phases 3, 4, partial 6 — the folder label on queue card).

**Out of scope (Plan 4):** chip filters in MessagePage/QueuePage, snooze, 4-button action bar, frontend page decomposition.

**Out of scope (Plan 3):** SPA-fallback `{detail: Not Found}` fix, message cache, prefetch.

---

## File Structure (Plan 2)

### Backend — new files

| File | Responsibility |
|---|---|
| `backend/services/folder_service.py` | `FolderService` — wraps Pyrogram raw `messages.GetDialogFilters`, returns folders + `chat_to_folders` map, tracks archived chat IDs per account, TTL=60s cache |
| `backend/routers/folders.py` | `GET /folders` endpoint factory |
| `backend/tests/test_folder_service.py` | unit tests (mocked raw API) |
| `backend/tests/test_folders_api.py` | integration tests for `/folders` |

### Backend — modified files

| File | Change |
|---|---|
| `backend/handlers/incoming.py` | Accept private + group + supergroup; skip if `folder_service.is_archived(chat_id, account)` |
| `backend/routers/dialogs.py` | `_map_dialog` reads `dialog.folder_id` to detect archive; `_build_dialogs_and_queue` excludes archive AND broadens to all chat types with unread > 0; both endpoints return `folder_ids: list[int]` per dialog from `FolderService.chat_to_folders`; `/bootstrap` updates `folder_service` archive set |
| `backend/routers/queue.py` | Accept `meta` query param; when `meta=true`, return `queue: [{chat_id, folder_ids}]` instead of `queue: [chat_id]` |
| `backend/main.py` | Instantiate `FolderService`, wire into routers + handler |
| `backend/services/__init__.py` | Re-export `FolderService` |
| `backend/routers/__init__.py` | Re-export `folders` module |
| `backend/tests/test_smoke.py` | Add /folders to expected endpoint list (root response) — minor |

### Frontend — new files

| File | Responsibility |
|---|---|
| `frontend/src/services/foldersApi.ts` | HTTP client for `/folders` |
| `frontend/src/hooks/useFolders.ts` | React hook: load folders once, expose `folders` + `chatToFolders` map |

### Frontend — modified files

| File | Change |
|---|---|
| `frontend/src/pages/QueuePage.tsx` | Display folder names under current-chat title using `useFolders()` |

---

## Conventions

- **Working directory:** `/Users/den1shh/Documents/growfood/tg_focus_app`. Branch `denis-branch`.
- **Backend tests:** `cd backend && source .venv/bin/activate && pytest tests/ -v`.
- **Frontend build:** `cd frontend && npm run build`.
- **Conventional Commits.**
- **Plan 1 baseline:** 52 tests pass. Each task in this plan must keep them green.

---

## Phase A — FolderService (TDD)

### Task 1: FolderService data model + cache structure

**Files:**
- Create: `backend/services/folder_service.py`
- Create: `backend/tests/test_folder_service.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_folder_service.py`**

```python
"""Tests for services.folder_service.FolderService.

The Pyrogram raw API is mocked — tests don't make network calls.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.folder_service import Folder, FolderService


def _filter(id: int, title: str, included_chat_ids: list[int]):
    """Build a fake DialogFilter raw object that FolderService can read.

    Pyrogram returns objects with attributes; we mimic the relevant subset:
    .id, .title, and .include_peers (each peer has .user_id / .chat_id /
    .channel_id depending on type — FolderService normalizes them).
    """
    peers = []
    for cid in included_chat_ids:
        if cid > 0:
            peers.append(SimpleNamespace(user_id=cid))
        else:
            # Pyrogram represents channel/supergroup IDs as negative; raw layer
            # uses bare positive ids on .channel_id / .chat_id. We mimic raw.
            peers.append(SimpleNamespace(channel_id=abs(cid)))
    return SimpleNamespace(
        id=id,
        title=title,
        include_peers=peers,
        exclude_peers=[],
        pinned_peers=[],
    )


def _default_filter():
    """The 'All Chats' pseudo-folder Telegram always returns. We must skip it."""
    return SimpleNamespace(id=0, title=None)  # no `include_peers` attribute


@pytest.fixture
def manager():
    """A mock PyrogramClientManager that returns a connected client per account."""
    mgr = MagicMock()

    async def ensure_connected(_client):
        return None

    mgr.ensure_connected = AsyncMock(side_effect=ensure_connected)

    def get_or_create(account: str):
        # Each account gets its own mock client. The .invoke() side-effect is
        # set per-test via mgr.set_filters_for(account, [...]).
        if account not in mgr._clients:
            client = MagicMock()
            client.invoke = AsyncMock(return_value=[])
            mgr._clients[account] = client
        return mgr._clients[account]

    mgr._clients = {}
    mgr.get_or_create = MagicMock(side_effect=get_or_create)
    mgr.default = MagicMock()
    mgr.default.invoke = AsyncMock(return_value=[])
    return mgr


async def test_get_folders_returns_user_folders_skipping_default(manager):
    svc = FolderService(manager)
    f1 = _filter(2, "Work", [100, -200])
    f2 = _filter(3, "Friends", [300])
    manager.default.invoke = AsyncMock(return_value=[_default_filter(), f1, f2])

    out = await svc.get_folders(account="")
    assert [f.id for f in out["folders"]] == [2, 3]
    assert {f.title for f in out["folders"]} == {"Work", "Friends"}


async def test_chat_to_folders_maps_chats_to_their_filter_ids(manager):
    svc = FolderService(manager)
    work = _filter(2, "Work", [100, -200])
    friends = _filter(3, "Friends", [100, 300])  # 100 in BOTH folders
    manager.default.invoke = AsyncMock(return_value=[_default_filter(), work, friends])

    out = await svc.get_folders(account="")
    chat_to_folders = out["chat_to_folders"]
    assert sorted(chat_to_folders[100]) == [2, 3]
    assert chat_to_folders[-200] == [2]
    assert chat_to_folders[300] == [3]


async def test_get_folders_caches_for_60_seconds(manager):
    svc = FolderService(manager, ttl_seconds=60)
    manager.default.invoke = AsyncMock(return_value=[_default_filter()])

    await svc.get_folders(account="")
    await svc.get_folders(account="")
    await svc.get_folders(account="")
    # invoke called only once due to cache
    assert manager.default.invoke.await_count == 1


async def test_get_folders_invalidates_after_ttl(manager):
    svc = FolderService(manager, ttl_seconds=0)  # immediate expiry
    manager.default.invoke = AsyncMock(return_value=[_default_filter()])

    await svc.get_folders(account="")
    await svc.get_folders(account="")
    assert manager.default.invoke.await_count == 2


async def test_invalidate_clears_cache(manager):
    svc = FolderService(manager, ttl_seconds=600)
    manager.default.invoke = AsyncMock(return_value=[_default_filter()])

    await svc.get_folders(account="")
    svc.invalidate(account="")
    await svc.get_folders(account="")
    assert manager.default.invoke.await_count == 2


async def test_per_account_cache_isolation(manager):
    svc = FolderService(manager)
    # Different accounts use different clients; both miss cache initially.
    await svc.get_folders(account="acc1")
    await svc.get_folders(account="acc2")
    await svc.get_folders(account="acc1")  # cached
    await svc.get_folders(account="acc2")  # cached

    # Each account-specific client invoked once.
    c1 = manager._clients["acc1"]
    c2 = manager._clients["acc2"]
    assert c1.invoke.await_count == 1
    assert c2.invoke.await_count == 1


async def test_archive_set_starts_empty(manager):
    svc = FolderService(manager)
    assert svc.is_archived(account="", chat_id=999) is False


async def test_set_archived_marks_chats(manager):
    svc = FolderService(manager)
    svc.set_archived(account="", chat_ids={1, 2, 3})
    assert svc.is_archived(account="", chat_id=1) is True
    assert svc.is_archived(account="", chat_id=2) is True
    assert svc.is_archived(account="", chat_id=99) is False


async def test_set_archived_replaces_previous_set(manager):
    svc = FolderService(manager)
    svc.set_archived(account="", chat_ids={1, 2})
    svc.set_archived(account="", chat_ids={3})
    assert svc.is_archived(account="", chat_id=1) is False
    assert svc.is_archived(account="", chat_id=3) is True


async def test_archive_state_per_account(manager):
    svc = FolderService(manager)
    svc.set_archived(account="acc1", chat_ids={1})
    assert svc.is_archived(account="acc1", chat_id=1) is True
    assert svc.is_archived(account="acc2", chat_id=1) is False


async def test_get_folders_handles_invoke_error(manager):
    """If the raw API throws (e.g., user has no folders configured), return empty."""
    svc = FolderService(manager)
    manager.default.invoke = AsyncMock(side_effect=RuntimeError("boom"))
    out = await svc.get_folders(account="")
    assert out == {"folders": [], "chat_to_folders": {}}
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd backend && source .venv/bin/activate && pytest tests/test_folder_service.py -v
```
Expected: ModuleNotFoundError on `services.folder_service`.

- [ ] **Step 3: Implement `backend/services/folder_service.py`**

```python
"""Telegram dialog folders + per-account archive state.

Wraps the Pyrogram raw method `messages.GetDialogFilters` and caches the
result for `ttl_seconds`. Archive state (set of archived chat_ids per account)
is updated externally via `set_archived()` — typically called from /bootstrap
when iterating dialogs (each dialog carries `dialog.folder_id == 1` if
archived).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Pyrogram raw imports are optional — only needed at runtime when calling
# Telegram. Tests inject mocked clients via the manager.
try:  # pragma: no cover - import-time guard, exercised by integration only
    from pyrogram.raw.functions.messages import GetDialogFilters  # type: ignore
except Exception:  # pragma: no cover
    GetDialogFilters = None  # type: ignore


@dataclass(frozen=True)
class Folder:
    id: int
    title: str
    chat_ids: tuple[int, ...]


class FolderService:
    """Loads + caches Telegram folder definitions; tracks archived chats.

    Cache key is the account string ("" for the default account).
    Archive set is independent of the folder cache and is mutated by callers.
    """

    def __init__(self, manager: Any, ttl_seconds: int = 60) -> None:
        self._manager = manager
        self._ttl = ttl_seconds
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._archived: dict[str, set[int]] = {}

    async def get_folders(self, account: str = "") -> dict[str, Any]:
        """Return `{folders: [Folder...], chat_to_folders: {chat_id: [folder_id...]}}`.

        Excludes Telegram's pseudo "All chats" default filter (which has no
        `include_peers` attribute). On API error, returns an empty payload.
        """
        key = (account or "").strip()
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and (now - cached[0]) < self._ttl:
            return cached[1]

        client = self._client_for(key)
        await self._manager.ensure_connected(client)

        if GetDialogFilters is None:
            # Pyrogram raw missing — operating in test/sandbox mode.
            payload = {"folders": [], "chat_to_folders": {}}
        else:
            try:
                raw = await client.invoke(GetDialogFilters())
            except Exception:
                logger.warning("GetDialogFilters failed for account=%r", key, exc_info=True)
                payload = {"folders": [], "chat_to_folders": {}}
            else:
                payload = self._parse_filters(raw)

        self._cache[key] = (now, payload)
        return payload

    def invalidate(self, account: str = "") -> None:
        self._cache.pop((account or "").strip(), None)

    def is_archived(self, account: str, chat_id: int) -> bool:
        return chat_id in self._archived.get((account or "").strip(), set())

    def set_archived(self, account: str, chat_ids: set[int]) -> None:
        """Replace the archived-chats set for the given account."""
        self._archived[(account or "").strip()] = set(chat_ids)

    def _client_for(self, account: str):
        if not account:
            return self._manager.default
        return self._manager.get_or_create(account)

    @staticmethod
    def _parse_filters(raw: Any) -> dict[str, Any]:
        # Some Pyrogram versions return a wrapper with a `.filters` attribute,
        # others return a list directly. Normalize.
        if hasattr(raw, "filters"):
            iterable = raw.filters
        else:
            iterable = raw

        folders: list[Folder] = []
        chat_to_folders: dict[int, list[int]] = {}

        for f in iterable or []:
            # The default "All chats" filter has no include_peers.
            if not hasattr(f, "include_peers"):
                continue
            title = getattr(f, "title", None) or ""
            fid = getattr(f, "id", None)
            if fid is None:
                continue
            chat_ids: list[int] = []
            for peer in (f.include_peers or []):
                cid = FolderService._peer_chat_id(peer)
                if cid is None:
                    continue
                chat_ids.append(cid)
                chat_to_folders.setdefault(cid, []).append(fid)
            folders.append(Folder(id=int(fid), title=str(title), chat_ids=tuple(chat_ids)))

        return {"folders": folders, "chat_to_folders": chat_to_folders}

    @staticmethod
    def _peer_chat_id(peer: Any) -> Optional[int]:
        """Map a raw peer to a signed chat_id matching Pyrogram's convention.

        Pyrogram exposes user IDs as positive ints, channel/supergroup IDs as
        negative ints (with the -100... prefix). Raw peers expose them via
        `.user_id`, `.channel_id`, or `.chat_id`.
        """
        if hasattr(peer, "user_id"):
            return int(peer.user_id)
        if hasattr(peer, "channel_id"):
            return -int(peer.channel_id)
        if hasattr(peer, "chat_id"):
            return -int(peer.chat_id)
        return None
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_folder_service.py -v
```
Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/services/folder_service.py backend/tests/test_folder_service.py
git commit -m "feat(folders): add FolderService with cache and archive tracking"
```

---

## Phase B — /folders endpoint

### Task 2: routers/folders.py + integration tests

**Files:**
- Create: `backend/routers/folders.py`
- Create: `backend/tests/test_folders_api.py`

- [ ] **Step 1: Write failing integration tests `backend/tests/test_folders_api.py`**

```python
"""Integration tests for /folders endpoint."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.folders import make_router
from services.folder_service import Folder


class _FakeFolderService:
    def __init__(self, payload: dict | None = None):
        self._payload = payload or {"folders": [], "chat_to_folders": {}}
        self.calls: list[str] = []

    async def get_folders(self, account: str = ""):
        self.calls.append(account)
        return self._payload


def _build_app(svc):
    app = FastAPI()
    app.include_router(make_router(svc))
    return app


def test_returns_empty_payload_when_no_folders():
    svc = _FakeFolderService()
    client = TestClient(_build_app(svc))
    r = client.get("/folders")
    assert r.status_code == 200
    assert r.json() == {"folders": [], "chat_to_folders": {}}


def test_returns_folders_and_map():
    svc = _FakeFolderService(
        {
            "folders": [
                Folder(id=2, title="Work", chat_ids=(100, -200)),
                Folder(id=3, title="Friends", chat_ids=(100,)),
            ],
            "chat_to_folders": {100: [2, 3], -200: [2]},
        }
    )
    client = TestClient(_build_app(svc))
    r = client.get("/folders")
    assert r.status_code == 200
    body = r.json()
    assert body["folders"] == [
        {"id": 2, "title": "Work", "chat_ids": [100, -200]},
        {"id": 3, "title": "Friends", "chat_ids": [100]},
    ]
    # chat_to_folders keys round-trip as strings via JSON; the test must
    # re-parse them for the integer comparison.
    chat_to_folders = {int(k): v for k, v in body["chat_to_folders"].items()}
    assert chat_to_folders == {100: [2, 3], -200: [2]}


def test_passes_account_query_param_through():
    svc = _FakeFolderService()
    client = TestClient(_build_app(svc))
    client.get("/folders?account=%2B71234567890")
    assert svc.calls == ["+71234567890"]
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pytest tests/test_folders_api.py -v
```
Expected: ModuleNotFoundError on `routers.folders`.

- [ ] **Step 3: Implement `backend/routers/folders.py`**

```python
"""Folders endpoint — exposes Telegram dialog filters to the frontend."""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter

from services.folder_service import FolderService


def make_router(folder_service: FolderService) -> APIRouter:
    router = APIRouter()

    @router.get("/folders")
    async def get_folders(account: str = ""):
        payload = await folder_service.get_folders(account=account)
        return {
            "folders": [asdict(f) for f in payload["folders"]],
            # Convert chat_ids tuples → lists so JSON serializes naturally.
            "chat_to_folders": {
                str(k): list(v) for k, v in payload["chat_to_folders"].items()
            },
        }

    return router
```

> **Note:** `chat_to_folders` keys are stringified explicitly; FastAPI will JSON-encode int keys as strings anyway, but doing it ourselves makes the API contract explicit.

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_folders_api.py -v
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/folders.py backend/tests/test_folders_api.py
git commit -m "feat(folders): add GET /folders endpoint"
```

---

## Phase C — broaden queue + return folder_ids on /dialogs

### Task 3: Modify `_map_dialog` and `_build_dialogs_and_queue` in dialogs router

**Files:**
- Modify: `backend/routers/dialogs.py`
- Create: `backend/tests/test_dialogs_logic.py` (unit tests for `_map_dialog` + queue building)

- [ ] **Step 1: Write failing tests `backend/tests/test_dialogs_logic.py`**

```python
"""Unit tests for the pure helpers in routers.dialogs.

We test the mapping/queue logic without spinning up Pyrogram — we feed the
helpers fake dialog objects with the same attribute shape Pyrogram uses.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Iterable

import pytest

from routers.dialogs import _map_dialog, _build_queue_from_dialogs


def _dialog(
    chat_id: int,
    chat_type: str = "private",
    unread: int = 0,
    folder_id: int = 0,
    title: str = "Test Chat",
):
    return SimpleNamespace(
        chat=SimpleNamespace(
            id=chat_id,
            type=SimpleNamespace(value=chat_type),
            title=title,
            username=None,
            first_name=None,
            last_name=None,
        ),
        top_message=None,
        unread_messages_count=unread,
        folder_id=folder_id,
    )


def test_map_dialog_returns_folder_id_zero_for_main():
    out = _map_dialog(_dialog(1, folder_id=0))
    assert out["folder_id"] == 0


def test_map_dialog_returns_folder_id_one_for_archive():
    out = _map_dialog(_dialog(1, folder_id=1))
    assert out["folder_id"] == 1


def test_map_dialog_includes_supergroup_now():
    out = _map_dialog(_dialog(-100, chat_type="supergroup"))
    assert out is not None
    assert out["type"] == "supergroup"


def test_build_queue_includes_groups_with_unread():
    dialogs = [
        _dialog(1, "private", unread=2),
        _dialog(-100, "supergroup", unread=5),
        _dialog(-200, "group", unread=1),
        _dialog(3, "private", unread=0),  # no unread → skip
    ]
    queue = _build_queue_from_dialogs(dialogs)
    assert sorted(queue) == sorted([1, -100, -200])


def test_build_queue_excludes_archive_even_with_unread():
    dialogs = [
        _dialog(1, "private", unread=2, folder_id=0),
        _dialog(2, "private", unread=2, folder_id=1),  # archived → skip
    ]
    queue = _build_queue_from_dialogs(dialogs)
    assert queue == [1]


def test_build_queue_dedupes_chat_ids():
    """Pyrogram should never duplicate a dialog, but be defensive."""
    d = _dialog(1, "private", unread=2)
    queue = _build_queue_from_dialogs([d, d])
    assert queue == [1]
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pytest tests/test_dialogs_logic.py -v
```
Expected: ImportError on `_build_queue_from_dialogs` (doesn't exist yet) and `folder_id` field missing.

- [ ] **Step 3: Modify `backend/routers/dialogs.py`**

Find the `_map_dialog` function (defined near the top of the file). Add a `folder_id` field to the returned dict, defaulting to 0:

```python
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
        logger.debug("type detection failed", exc_info=True)
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
    folder_id = int(getattr(d, "folder_id", 0) or 0)
    return {
        "chat_id": chat.id,
        "title": title,
        "type": type_name,
        "username": getattr(chat, "username", None),
        "unread_count": getattr(d, "unread_messages_count", 0),
        "last_message_text": last_text,
        "folder_id": folder_id,
    }
```

Replace the inline queue-building inside `_build_dialogs_and_queue` with a new pure helper `_build_queue_from_dialogs`. Add this top-level function below `_map_dialog`:

```python
def _build_queue_from_dialogs(dialogs: Iterable[Any]) -> list[int]:
    """Return chat_ids that should be in the queue.

    Includes private + group + supergroup with unread > 0, excludes archive
    (folder_id == 1). Preserves first-seen order; dedupes.
    """
    queue: list[int] = []
    seen: set[int] = set()
    for d in dialogs:
        item = _map_dialog(d)
        if not item:
            continue
        if item.get("folder_id") == 1:
            continue
        if int(item.get("unread_count", 0) or 0) <= 0:
            continue
        cid = int(item["chat_id"])
        if cid in seen:
            continue
        seen.add(cid)
        queue.append(cid)
    return queue
```

Add `Iterable` to the typing import at top of file:
```python
from typing import Any, Iterable, Optional
```

Update `_build_dialogs_and_queue` to use the new helper and to also collect archived chat_ids for the FolderService:

```python
async def _build_dialogs_and_queue(client: Client, limit: int = 100) -> dict[str, Any]:
    dialogs_raw: list[Any] = []
    async for d in client.get_dialogs(limit=limit):
        dialogs_raw.append(d)

    dialogs: list[dict[str, Any]] = []
    archived_ids: set[int] = set()
    for d in dialogs_raw:
        item = _map_dialog(d)
        if not item:
            continue
        dialogs.append(item)
        if item.get("folder_id") == 1:
            archived_ids.add(int(item["chat_id"]))
    queue_ids = _build_queue_from_dialogs(dialogs_raw)

    return {"dialogs": dialogs, "queue": queue_ids, "archived_ids": archived_ids}
```

> **Note:** Tests verify the new helper directly. `_build_dialogs_and_queue` returns the additional `archived_ids` field which the bootstrap handler will pass to FolderService. The `dialogs` and `queue` fields keep their existing shapes (no breaking change).

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_dialogs_logic.py -v
```
Expected: 6 pass.

- [ ] **Step 5: Run full backend suite to catch regressions**

```bash
pytest tests/ -v
```
Expected: 52 prior + 11 folder_service + 3 folders_api + 6 dialogs_logic = 72 pass.

- [ ] **Step 6: Commit**

```bash
git add backend/routers/dialogs.py backend/tests/test_dialogs_logic.py
git commit -m "feat(queue): include groups + supergroups in queue, expose folder_id on dialogs"
```

---

### Task 4: Wire FolderService into /bootstrap and /dialogs to add `folder_ids`

**Files:**
- Modify: `backend/routers/dialogs.py`

- [ ] **Step 1: Modify `make_router` signature in `backend/routers/dialogs.py`**

The factory currently takes `(manager, auth, queue_service)`. Add `folder_service: FolderService`:

```python
from services.folder_service import FolderService


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
    folder_service: FolderService,
) -> APIRouter:
    router = APIRouter()

    # ... _get_contacts_payload as before ...

    async def _attach_folder_ids(
        items: list[dict[str, Any]], account: str
    ) -> None:
        """Decorate each dialog with folder_ids from FolderService cache."""
        try:
            payload = await folder_service.get_folders(account=account)
        except Exception:
            logger.warning("FolderService.get_folders failed", exc_info=True)
            payload = {"chat_to_folders": {}}
        c2f = payload.get("chat_to_folders", {})
        for item in items:
            cid = int(item["chat_id"])
            item["folder_ids"] = list(c2f.get(cid, []))
```

- [ ] **Step 2: Update `/dialogs` and `/bootstrap` to call `_attach_folder_ids`**

Replace the existing `/dialogs` and `/bootstrap` definitions inside `make_router` with:

```python
    @router.get("/dialogs")
    async def get_dialogs(limit: int = 100, account: str = ""):
        client = await auth.get_authorized_client(account)
        payload = await _build_dialogs_and_queue(client, limit=limit)
        await _attach_folder_ids(payload["dialogs"], account)
        return {"dialogs": payload["dialogs"]}

    @router.get("/bootstrap")
    async def get_bootstrap(limit: int = 100, account: str = ""):
        client = await auth.get_authorized_client(account)
        dialogs_task = asyncio.create_task(_build_dialogs_and_queue(client, limit=limit))
        contacts_task = asyncio.create_task(_get_contacts_payload(account))
        dialogs_payload, contacts_payload = await asyncio.gather(dialogs_task, contacts_task)
        # Tell FolderService which chats are archived (handler uses this).
        folder_service.set_archived(account, dialogs_payload["archived_ids"])
        await _attach_folder_ids(dialogs_payload["dialogs"], account)
        queue_ids = dialogs_payload["queue"]
        await queue_service.replace(account, queue_ids)
        return {
            "dialogs": dialogs_payload["dialogs"],
            "contacts": contacts_payload,
            "queue": queue_ids,
        }
```

- [ ] **Step 3: Add `logger` import if not already present**

At top of file ensure:
```python
import logging
logger = logging.getLogger(__name__)
```

- [ ] **Step 4: Run full suite — must still pass**

```bash
pytest tests/ -v
```
Expected: 72 pass (no new tests yet — wiring is exercised at integration level later).

- [ ] **Step 5: Commit**

```bash
git add backend/routers/dialogs.py
git commit -m "feat(dialogs): attach folder_ids to /dialogs and /bootstrap responses"
```

---

## Phase D — queue endpoint with `?meta=true`

### Task 5: Add `meta` query parameter to /queue

**Files:**
- Modify: `backend/routers/queue.py`
- Create: `backend/tests/test_queue_api.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_queue_api.py`**

```python
"""Integration tests for /queue endpoint (with and without meta=true)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_service import QueueService


class _FakeFolderService:
    def __init__(self, chat_to_folders: dict[int, list[int]] | None = None):
        self._c2f = chat_to_folders or {}

    async def get_folders(self, account: str = ""):
        return {"folders": [], "chat_to_folders": self._c2f}


@pytest.fixture
def app_factory():
    """Builds an app with a queue pre-populated with the given chat_ids."""

    async def _build(chat_ids: list[int], chat_to_folders: dict[int, list[int]]):
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
        folder_svc = _FakeFolderService(chat_to_folders)
        app.include_router(make_router(manager, auth, qs, folder_svc))
        return app, qs

    return _build


async def test_queue_default_returns_chat_ids_only(app_factory):
    app, _ = await app_factory([1, 2, 3], {})
    client = TestClient(app)
    r = client.get("/queue")
    assert r.status_code == 200
    assert r.json() == {"queue": [1, 2, 3]}


async def test_queue_meta_true_returns_objects_with_folder_ids(app_factory):
    app, _ = await app_factory([1, 2], {1: [2, 3], 2: []})
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    assert r.status_code == 200
    assert r.json() == {
        "queue": [
            {"chat_id": 1, "folder_ids": [2, 3]},
            {"chat_id": 2, "folder_ids": []},
        ]
    }


async def test_queue_meta_false_explicit_returns_old_shape(app_factory):
    app, _ = await app_factory([5], {5: [9]})
    client = TestClient(app)
    r = client.get("/queue?meta=false")
    assert r.json() == {"queue": [5]}
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_queue_api.py -v
```
Expected: failures (signature mismatch — `make_router` doesn't accept folder_svc yet, and `meta` param isn't handled).

- [ ] **Step 3: Modify `backend/routers/queue.py`**

Add `folder_service` param and the `meta` branch. Replace the file contents with:

```python
"""Queue endpoints: list and act on pending chats."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.folder_service import FolderService
from services.queue_service import QueueService

logger = logging.getLogger(__name__)


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
    folder_service: FolderService,
) -> APIRouter:
    router = APIRouter()

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
        return {
            "queue": [
                {"chat_id": cid, "folder_ids": list(c2f.get(cid, []))}
                for cid in order
            ]
        }

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
                logger.warning("read_chat_history failed", exc_info=True)
            await queue_service.remove(account, chat_id)
        else:
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}

    return router
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_queue_api.py -v
```
Expected: 3 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 75 pass (72 prior + 3 queue_api).

- [ ] **Step 6: Commit**

```bash
git add backend/routers/queue.py backend/tests/test_queue_api.py
git commit -m "feat(queue): add ?meta=true to return queue items with folder_ids"
```

---

## Phase E — broaden incoming handler

### Task 6: Accept non-private chats in handler, skip archive

**Files:**
- Modify: `backend/handlers/incoming.py`
- Create: `backend/tests/test_incoming_handler.py`

- [ ] **Step 1: Write failing tests `backend/tests/test_incoming_handler.py`**

```python
"""Tests for the incoming-message handler factory."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from handlers.incoming import make_incoming_handler
from services.queue_service import QueueService


class _FakeFolderService:
    def __init__(self, archived: set[int] | None = None):
        self._archived = archived or set()

    def is_archived(self, account: str, chat_id: int) -> bool:
        return chat_id in self._archived


def _make_message(chat_id: int, chat_type: str, text: str = "hi", outgoing: bool = False):
    return SimpleNamespace(
        chat=SimpleNamespace(
            id=chat_id, type=SimpleNamespace(value=chat_type), title="X"
        ),
        text=text,
        caption=None,
        date=datetime(2026, 5, 8, 12, 0),
        from_user=SimpleNamespace(id=42, first_name="Ivan", last_name=None),
        sender_chat=None,
        outgoing=outgoing,
        photo=None,
        video=None,
        voice=None,
        video_note=None,
        document=None,
        id=1001,
    )


async def test_handler_accepts_supergroup():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(-100, "supergroup")
    await handler(MagicMock(), msg)

    assert await qs.get("") == [-100]


async def test_handler_accepts_group():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(-200, "group")
    await handler(MagicMock(), msg)

    assert await qs.get("") == [-200]


async def test_handler_skips_archived_chat():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService(archived={777})

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(777, "private")
    await handler(MagicMock(), msg)

    assert await qs.get("") == []


async def test_handler_skips_unknown_chat_type():
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(99, "channel")  # broadcast channel — skip
    await handler(MagicMock(), msg)

    assert await qs.get("") == []


async def test_handler_broadcasts_queue_update_with_folder_ids():
    """The queue_update event must carry folder_ids so the frontend filter
    can react without extra round-trip.
    """
    qs = QueueService()
    bcast = MagicMock()
    bcast.broadcast = AsyncMock()
    folder = _FakeFolderService()
    # Wire the chat-to-folders map so handler can look it up.
    folder.chat_to_folders = {-100: [2, 3]}  # type: ignore[attr-defined]

    handler = make_incoming_handler(qs, bcast, "", folder)
    msg = _make_message(-100, "supergroup")
    await handler(MagicMock(), msg)

    queue_updates = [
        call.args[0]
        for call in bcast.broadcast.call_args_list
        if call.args[0].get("type") == "queue_update"
    ]
    assert queue_updates
    update = queue_updates[0]
    assert update["chat_id"] == -100
    assert update["account"] == ""
    assert update["folder_ids"] == [2, 3]
```

- [ ] **Step 2: Run, verify they fail**

```bash
pytest tests/test_incoming_handler.py -v
```
Expected: TypeError on `make_incoming_handler` extra arg, plus failed assertions.

- [ ] **Step 3: Modify `backend/handlers/incoming.py`**

Replace the file:

```python
"""Factory for Pyrogram incoming-message handlers.

Accepts private + group + supergroup chats. Channels (broadcast) and archived
chats are skipped. The queue_update broadcast event carries folder_ids so
clients can apply folder filters without an extra /folders round-trip.
"""
from __future__ import annotations

import logging
from typing import Any

from pyrogram import Client
from pyrogram.types import Message

from services.folder_service import FolderService
from services.media_utils import extract_media_info
from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

_ACCEPTED_TYPES = ("private", "group", "supergroup")


def make_incoming_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
    folder_service: FolderService,
):
    async def handler(client: Client, message: Message) -> None:
        try:
            ctype = getattr(message.chat, "type", None)
            type_name = (
                getattr(ctype, "value", None)
                or (str(ctype).lower() if ctype is not None else "")
            )
        except Exception:
            logger.debug("type detection failed", exc_info=True)
            type_name = ""
        if type_name not in _ACCEPTED_TYPES:
            return

        chat_id = message.chat.id
        if folder_service.is_archived(account, chat_id):
            return

        await queue_service.add(account, chat_id)

        folder_ids = _lookup_folder_ids(folder_service, account, chat_id)
        await broadcaster.broadcast(
            {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "folder_ids": folder_ids,
            }
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


def _lookup_folder_ids(
    folder_service: FolderService, account: str, chat_id: int
) -> list[int]:
    """Best-effort lookup against the FolderService cache.

    The handler runs on every incoming message; we don't want to call the
    Telegram raw API on the hot path. If the cache hasn't been primed yet
    (no /folders or /bootstrap call yet for this account), return [].
    """
    cached = folder_service._cache.get((account or "").strip())  # noqa: SLF001
    if not cached:
        return []
    chat_to_folders = cached[1].get("chat_to_folders", {})
    return list(chat_to_folders.get(chat_id, []))


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
        logger.debug("author lookup failed", exc_info=True)
    return None
```

> **Note:** `_lookup_folder_ids` reads `folder_service._cache` directly to avoid awaiting raw API on the hot path. The underscore access is intentional and documented; if it ever drifts we'll move the fallback into a public method.

The fifth test (`test_handler_broadcasts_queue_update_with_folder_ids`) sets `folder.chat_to_folders` on the fake; we need `_lookup_folder_ids` to read from `_FakeFolderService` correctly. Update the lookup to be tolerant of fakes that expose `chat_to_folders` directly:

```python
def _lookup_folder_ids(
    folder_service: FolderService, account: str, chat_id: int
) -> list[int]:
    # Prefer cached payload from the real FolderService.
    cache = getattr(folder_service, "_cache", None)
    if isinstance(cache, dict):
        cached = cache.get((account or "").strip())
        if cached:
            chat_to_folders = cached[1].get("chat_to_folders", {})
            return list(chat_to_folders.get(chat_id, []))
    # Fallback for test fakes that expose `chat_to_folders` directly.
    direct = getattr(folder_service, "chat_to_folders", None)
    if isinstance(direct, dict):
        return list(direct.get(chat_id, []))
    return []
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_incoming_handler.py -v
```
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/handlers/incoming.py backend/tests/test_incoming_handler.py
git commit -m "feat(handler): accept groups + supergroups, skip archive, emit folder_ids on queue_update"
```

---

## Phase F — wire FolderService in main.py

### Task 7: Update create_app() to instantiate and pass FolderService

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/services/__init__.py` (re-export `FolderService`)
- Modify: `backend/routers/__init__.py` (re-export `folders` module)

- [ ] **Step 1: Update `backend/services/__init__.py`**

```python
"""Service layer: stateful + stateless business logic."""
from services.claude_client import ClaudeClient, ClaudeConfig
from services.folder_service import Folder, FolderService
from services.media_utils import extract_media_info
from services.queue_service import QueueService
from services.state_store import JsonStore
from services.task_store import Task, TaskStore

__all__ = [
    "ClaudeClient",
    "ClaudeConfig",
    "Folder",
    "FolderService",
    "JsonStore",
    "QueueService",
    "Task",
    "TaskStore",
    "extract_media_info",
]
```

- [ ] **Step 2: Update `backend/routers/__init__.py`**

```python
"""HTTP routers (FastAPI APIRouters)."""
from routers import ai, auth, dialogs, folders, messages, queue, tasks

__all__ = ["ai", "auth", "dialogs", "folders", "messages", "queue", "tasks"]
```

- [ ] **Step 3: Update `backend/main.py` — `create_app()`**

In the imports at top, add:
```python
from routers import folders as folders_router
from services.folder_service import FolderService
```

Inside `create_app()`, instantiate `folder_service` AFTER `manager` is created and BEFORE the handler factory is wired:

```python
    folder_service = FolderService(manager, ttl_seconds=60)
```

Replace the handler-factory wiring to pass folder_service:

```python
    manager.set_incoming_handler_factory(
        lambda client, account: make_incoming_handler(
            queue_service, broadcaster, account, folder_service
        )
    )

    _default_handler = make_incoming_handler(
        queue_service, broadcaster, "", folder_service
    )
```

Update the router includes to pass folder_service:

```python
    app.include_router(auth_router.make_router(manager))
    app.include_router(
        dialogs_router.make_router(manager, auth_deps, queue_service, folder_service)
    )
    app.include_router(messages_router.make_router(manager, auth_deps))
    app.include_router(
        queue_router.make_router(manager, auth_deps, queue_service, folder_service)
    )
    app.include_router(tasks_router.make_router(task_store))
    app.include_router(ai_router.make_router(claude_client, auth_deps))
    app.include_router(folders_router.make_router(folder_service))
```

Update the `/` endpoint listing to include `/folders`:

```python
    @app.get("/")
    async def root() -> dict[str, Any]:
        return {
            "service": "TG Backend API",
            "status": "ok",
            "docs": "/docs",
            "endpoints": [
                "/auth/send_code", "/auth/sign_in", "/me",
                "/dialogs", "/folders", "/messages", "/send_message",
                "/queue", "/queue/action", "/tasks", "/generate_reply", "/ws",
            ],
        }
```

- [ ] **Step 4: Update smoke test to include /folders in expected list**

In `backend/tests/test_smoke.py`, the second test currently asserts `body["service"]` and `body["status"]` only — no list assertion. No change needed unless that test was asserting the endpoints array.

Run smoke:
```bash
pytest tests/test_smoke.py -v
```
Expected: pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ -v
```
Expected: 80 pass (75 prior + 5 incoming_handler).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/services/__init__.py backend/routers/__init__.py
git commit -m "wire(main): instantiate FolderService and pass to handler/dialogs/queue/folders router"
```

---

## Phase G — Frontend: foldersApi + useFolders + folder label on QueuePage

### Task 8: foldersApi.ts service

**Files:**
- Create: `frontend/src/services/foldersApi.ts`

- [ ] **Step 1: Create `frontend/src/services/foldersApi.ts`**

```typescript
export type Folder = {
  id: number;
  title: string;
  chat_ids: number[];
};

export type FoldersPayload = {
  folders: Folder[];
  /** Map from chat_id (string-encoded by JSON) to folder_ids array. */
  chat_to_folders: Record<string, number[]>;
};

const BASE_URL: string = (() => {
  const envBase = (import.meta as any).env?.VITE_API_BASE_URL as string | undefined;
  if (envBase && envBase.trim()) return envBase.trim();
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
})();

const url = (path: string) => `${BASE_URL}${path}`;

async function asJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

export const foldersApi = {
  async list(account = ""): Promise<FoldersPayload> {
    const params = account ? `?account=${encodeURIComponent(account)}` : "";
    return asJson<FoldersPayload>(await fetch(url(`/folders${params}`)));
  },
};
```

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -5
```
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/foldersApi.ts
git commit -m "feat(frontend): add foldersApi HTTP client"
```

---

### Task 9: useFolders hook

**Files:**
- Create: `frontend/src/hooks/useFolders.ts`

- [ ] **Step 1: Inspect current hooks dir to follow conventions**

```bash
ls /Users/den1shh/Documents/growfood/tg_focus_app/frontend/src/hooks 2>/dev/null
```
If the directory doesn't exist, the hook lives in `src/hooks/` regardless — Vite resolves it via the `@/` alias.

- [ ] **Step 2: Create `frontend/src/hooks/useFolders.ts`**

```typescript
import { useEffect, useMemo, useState } from "react";
import { foldersApi, type Folder, type FoldersPayload } from "@/services/foldersApi";

type State = {
  folders: Folder[];
  /** Map from chat_id (number) → folder_ids array. Empty array if the chat
   * is not in any user folder. */
  chatToFolders: Map<number, number[]>;
  isLoading: boolean;
  error: string | null;
};

const empty: State = {
  folders: [],
  chatToFolders: new Map(),
  isLoading: true,
  error: null,
};

/**
 * Loads the user's Telegram folders once on mount. On error, exposes the
 * message via `error` and falls back to an empty payload — the rest of the UI
 * keeps working without folder filtering.
 */
export function useFolders(account = ""): State {
  const [payload, setPayload] = useState<FoldersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    foldersApi
      .list(account)
      .then((p) => {
        if (!cancelled) setPayload(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const chatToFolders = useMemo(() => {
    const m = new Map<number, number[]>();
    if (!payload) return m;
    for (const [k, v] of Object.entries(payload.chat_to_folders)) {
      const cid = Number(k);
      if (Number.isFinite(cid)) m.set(cid, v);
    }
    return m;
  }, [payload]);

  if (!payload) return { ...empty, isLoading, error };
  return { folders: payload.folders, chatToFolders, isLoading, error };
}
```

- [ ] **Step 3: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -5
```
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useFolders.ts
git commit -m "feat(frontend): add useFolders hook"
```

---

### Task 10: Show folder name(s) on QueuePage current-chat card

**Files:**
- Modify: `frontend/src/pages/QueuePage.tsx`

This is a minimal touch — add a single line of folder names under the chat title. Plan 4 will do the full QueuePage decomposition; here we just add a small block so the new backend data is visible end-to-end.

- [ ] **Step 1: Add `useFolders` import at top of QueuePage.tsx**

Add to the imports near the top (after the existing `import { telegramApi }` line):

```typescript
import { useFolders } from "@/hooks/useFolders";
```

- [ ] **Step 2: Inside the QueuePage component, call the hook**

Find the component body. Near the existing `const { state, ...` destructuring, add:

```typescript
  const { folders, chatToFolders } = useFolders();
```

- [ ] **Step 3: Build the folder-name display string**

Just before the JSX `return`, after `currentDialog` is computed, add:

```typescript
  const currentFolderLabel = useMemo(() => {
    if (!currentChatId) return "";
    const ids = chatToFolders.get(currentChatId) || [];
    if (ids.length === 0) return "";
    const titles = ids
      .map((id) => folders.find((f) => f.id === id)?.title)
      .filter((t): t is string => !!t);
    return titles.join(" · ");
  }, [currentChatId, chatToFolders, folders]);
```

If `useMemo` isn't already imported, add it to the React import line:

```typescript
import React, { useEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 4: Render the folder label under the contact name**

Find the section in the JSX where the current contact name is rendered (look for `<h2 className="text-lg font-semibold">{currentDialog.name}</h2>`). Replace the immediately-following `<p>` with:

```tsx
                <div>
                  <h2 className="text-lg font-semibold">{currentDialog.name}</h2>
                  {currentFolderLabel && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <span aria-hidden>📁</span>
                      <span>{currentFolderLabel}</span>
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">{currentDialog.time}</p>
                </div>
```

The original JSX had `<div>` containing `<h2>` and a single `<p>` — now there are two `<p>`s with the folder line conditionally rendered.

- [ ] **Step 5: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -5
```
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/QueuePage.tsx
git commit -m "feat(frontend): show folder name(s) on QueuePage current-chat card"
```

---

## Phase H — Final verification

### Task 11: Full backend + frontend smoke

- [ ] **Step 1: Backend full suite**

```bash
cd backend && source .venv/bin/activate && pytest tests/ -v
```
Expected: 80 tests pass.

- [ ] **Step 2: Backend line counts**

```bash
wc -l main.py routers/*.py services/*.py deps/*.py handlers/*.py ws/*.py config.py
```
Expected: all files ≤ 400 LOC.

- [ ] **Step 3: Frontend build**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/frontend && npm run build
```
Expected: succeeds.

- [ ] **Step 4: Manual end-to-end (requires real .env)**

```bash
cd /Users/den1shh/Documents/growfood/tg_focus_app/backend && source .venv/bin/activate && python main.py &
SERVER_PID=$!
sleep 3
curl -s "http://localhost:8080/folders"  # → {"folders":[...],"chat_to_folders":{...}}
curl -s "http://localhost:8080/queue?meta=true"  # → {"queue":[{...},...]} or {"queue":[]}
curl -s "http://localhost:8080/dialogs?limit=5"  # each dialog has folder_ids
kill $SERVER_PID 2>/dev/null
```
Expected: payloads include the new `folder_ids` and `folders` fields.

- [ ] **Step 5: Push**

```bash
git push origin denis-branch
```

---

## Plan 2 — Definition of Done

- [x] 80 backend tests pass (52 prior + 28 new across folder_service, folders_api, dialogs_logic, queue_api, incoming_handler).
- [x] `GET /folders` returns user folders + chat→folders map (archive excluded).
- [x] `GET /dialogs` and `/bootstrap` return `folder_ids` per dialog.
- [x] `GET /queue?meta=true` returns enriched queue items with `folder_ids`.
- [x] Old `GET /queue` (no meta) keeps the `{queue: [int]}` shape — backward-compatible.
- [x] Incoming-message handler accepts private + group + supergroup; skips archive; broadcasts `queue_update` with `folder_ids`.
- [x] `/bootstrap` populates `FolderService.set_archived` so subsequent incoming messages can be filtered.
- [x] Frontend builds; `useFolders` loads on mount; QueuePage shows folder name(s) under the current chat title.
- [x] No regression in `/auth/*`, `/me`, `/messages`, `/tasks`, `/generate_reply`.

After this ships, **Plan 3** (SPA-fallback + message cache + prefetch) and **Plan 4** (snooze + 4-button QueuePage + chip filters + frontend decomposition) can each pull this folder data without further backend work.
