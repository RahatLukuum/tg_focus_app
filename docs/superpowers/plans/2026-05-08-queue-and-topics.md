# Queue & Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec A — fix queue UX bugs (filters, header, author/topic display, stale TaskFromChatForm title), make outgoing messages auto-remove a chat from the queue, and add full forum-supergroup (topics) navigation end-to-end.

**Architecture:** New `services/topics_service.py` mirrors `folder_service` pattern (TTL cache around `client.get_forum_topics`). New `routers/topics.py`. New outgoing-message Pyrogram handler removes chats from queue. Existing `routers/queue.py` is enriched with a `last_message` snapshot (cached via `services/response_cache.TtlCache`). Frontend gets a `TopicsPage`, an upgraded `QueueFilter`, and a `key={chatId}` fix for the stale-state form.

**Tech Stack:** FastAPI, Pyrogram 2.0.106 (`get_forum_topics`, `message_thread_id`), pytest-asyncio (asyncio_mode=auto), React + TypeScript + react-router-dom v6, idb-keyval.

**Spec:** [docs/superpowers/specs/2026-05-08-queue-and-topics-design.md](../specs/2026-05-08-queue-and-topics-design.md)

---

## File map

**Backend — create:**
- `backend/handlers/outgoing.py` — new factory for outgoing-message handler (queue auto-remove)
- `backend/services/topics_service.py` — TTL-cached wrapper around `get_forum_topics`
- `backend/routers/topics.py` — `GET /topics`
- `backend/services/queue_meta_cache.py` — TtlCache for queue last-message snapshots
- `backend/tests/test_outgoing_handler.py`
- `backend/tests/test_topics_service.py`
- `backend/tests/test_topics_api.py`
- `backend/tests/test_queue_meta_extended.py`
- `backend/tests/test_messages_topic_id.py`

**Backend — modify:**
- `backend/main.py` — wire outgoing handler + topics router + queue_meta_cache + invalidate hooks
- `backend/deps/pyrogram_clients.py` — register outgoing handler factory similarly to incoming
- `backend/routers/messages.py` — accept `topic_id` on `/messages` and `message_thread_id` on `/send_message`
- `backend/routers/queue.py` — `meta=true` returns `last_message`, `topic_id`, `topic_title`
- `backend/routers/dialogs.py` — `_map_dialog` returns `is_forum`
- `backend/handlers/incoming.py` — broadcast `topic_id`/`topic_title` for forum chats; invalidate queue_meta_cache

**Frontend — create:**
- `frontend/src/pages/TopicsPage.tsx`
- `frontend/src/components/queue/QueueFilter.tsx`

**Frontend — modify:**
- `frontend/src/types/telegram.ts` — `Chat.isForum?: boolean`, `Topic` type
- `frontend/src/services/telegramApi.ts` — `getTopics`, `getMessages` topic, `sendMessage` topic
- `frontend/src/components/queue/QueueActionsBar.tsx` — add `key={chatId}` to TaskFromChatForm
- `frontend/src/pages/QueuePage.tsx` — remove `1/N`, render media+author+topic on card, swap filter component
- `frontend/src/pages/MessagePage.tsx` — forum-supergroup click → `/chat/:id/topics`
- `frontend/src/pages/ChatPage.tsx` — pass `?topic_id=N` query through to API
- `frontend/src/App.tsx` — add `/chat/:id/topics` route

**Frontend — delete:**
- `frontend/src/components/queue/QueueFolderFilter.tsx` — superseded by `QueueFilter`

---

## Task 1: Outgoing-message handler

**Files:**
- Create: `backend/handlers/outgoing.py`
- Create: `backend/tests/test_outgoing_handler.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_outgoing_handler.py`:

```python
"""Tests for the outgoing-message handler factory."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from handlers.outgoing import make_outgoing_handler
from services.queue_service import QueueService


def _msg(chat_id: int, chat_type: str = "private", outgoing: bool = True):
    return SimpleNamespace(
        chat=SimpleNamespace(id=chat_id, type=SimpleNamespace(value=chat_type), title="X"),
        text="ok", caption=None, date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=42, first_name="Me", last_name=None),
        sender_chat=None, outgoing=outgoing,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        id=1,
    )


async def test_outgoing_in_queued_chat_removes_from_queue():
    qs = QueueService()
    await qs.add("acc", 100)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_outgoing_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), message=_msg(100))

    assert await qs.get("acc") == []
    bcast.broadcast.assert_awaited_once()
    payload = bcast.broadcast.call_args.args[0]
    assert payload["type"] == "queue_update"
    assert payload["chat_id"] == 100
    cache.invalidate.assert_called_once_with("acc", 100)


async def test_outgoing_in_unqueued_chat_is_noop():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_outgoing_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), message=_msg(999))

    bcast.broadcast.assert_not_awaited()
    cache.invalidate.assert_not_called()


async def test_outgoing_unsupported_chat_type_is_noop():
    qs = QueueService()
    await qs.add("acc", 100)
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock()
    handler = make_outgoing_handler(qs, bcast, "acc", queue_meta_cache=cache)

    await handler(client=MagicMock(), message=_msg(100, chat_type="channel"))

    assert await qs.get("acc") == [100]
    bcast.broadcast.assert_not_awaited()
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_outgoing_handler.py -v
```

Expected: `ModuleNotFoundError: No module named 'handlers.outgoing'`.

- [ ] **Step 3: Implement the handler**

Create `backend/handlers/outgoing.py`:

```python
"""Pyrogram handler: outgoing messages → remove chat from queue.

Mirrors handlers/incoming.py but listens on filters.outgoing. When the user
sends (or sends-from-another-device) a message in a chat that is currently
in the queue, the chat is considered handled and removed.
"""
from __future__ import annotations

import logging
from typing import Optional

from pyrogram import Client
from pyrogram.types import Message

from services.queue_service import QueueService
from ws.broadcaster import Broadcaster

logger = logging.getLogger(__name__)

_ACCEPTED_TYPES = ("private", "group", "supergroup")


def make_outgoing_handler(
    queue_service: QueueService,
    broadcaster: Broadcaster,
    account: str,
    queue_meta_cache=None,
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
            return
        if type_name not in _ACCEPTED_TYPES:
            return

        chat_id = message.chat.id
        order = await queue_service.get(account)
        if chat_id not in order:
            return

        await queue_service.remove(account, chat_id)
        if queue_meta_cache is not None:
            try:
                queue_meta_cache.invalidate(account, chat_id)
            except Exception:
                logger.debug("queue meta cache invalidate failed", exc_info=True)

        await broadcaster.broadcast(
            {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "removed": True,
            }
        )

    return handler
```

- [ ] **Step 4: Run test to verify it passes**

```
cd backend && python -m pytest tests/test_outgoing_handler.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add backend/handlers/outgoing.py backend/tests/test_outgoing_handler.py
git commit -m "feat(handlers): outgoing-message handler removes chat from queue"
```

---

## Task 2: TopicsService

**Files:**
- Create: `backend/services/topics_service.py`
- Create: `backend/tests/test_topics_service.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_topics_service.py`:

```python
"""Tests for TopicsService TTL cache."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.topics_service import TopicsService


def _topic(tid: int, title: str):
    return SimpleNamespace(
        id=tid,
        title=title,
        icon_color=9367192,
        icon_emoji_id=None,
        unread_count=0,
        top_message=None,
    )


class _FakeManager:
    def __init__(self, client):
        self._client = client
        self.default = client

    def get_or_create(self, account: str):
        return self._client

    async def ensure_connected(self, client):
        return None


async def _aiter(items):
    for x in items:
        yield x


async def test_get_topics_caches_within_ttl():
    client = MagicMock()
    client.get_forum_topics = MagicMock(return_value=_aiter([_topic(1, "General"), _topic(2, "Bugs")]))
    svc = TopicsService(_FakeManager(client), ttl_seconds=60)

    first = await svc.get_topics(account="", chat_id=-100123)
    second = await svc.get_topics(account="", chat_id=-100123)

    assert [t["topic_id"] for t in first] == [1, 2]
    assert first == second
    # Should have only invoked Pyrogram once due to caching.
    assert client.get_forum_topics.call_count == 1


async def test_get_topics_returns_empty_on_error():
    client = MagicMock()
    def boom(_chat_id):
        raise RuntimeError("not a forum")
    client.get_forum_topics = boom
    svc = TopicsService(_FakeManager(client))

    result = await svc.get_topics(account="", chat_id=-100123)

    assert result == []


async def test_get_topic_title_returns_none_when_missing():
    client = MagicMock()
    client.get_forum_topics = MagicMock(return_value=_aiter([_topic(1, "General")]))
    svc = TopicsService(_FakeManager(client))

    title = await svc.get_topic_title(account="", chat_id=-100123, topic_id=999)

    assert title is None


async def test_get_topic_title_returns_cached_match():
    client = MagicMock()
    client.get_forum_topics = MagicMock(return_value=_aiter([_topic(1, "General"), _topic(2, "Bugs")]))
    svc = TopicsService(_FakeManager(client))

    # Prime cache
    await svc.get_topics(account="", chat_id=-100123)
    # Should not refetch
    title = await svc.get_topic_title(account="", chat_id=-100123, topic_id=2)

    assert title == "Bugs"
    assert client.get_forum_topics.call_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_topics_service.py -v
```

Expected: `ModuleNotFoundError: No module named 'services.topics_service'`.

- [ ] **Step 3: Implement TopicsService**

Create `backend/services/topics_service.py`:

```python
"""Telegram forum-supergroup topics — TTL-cached wrapper.

Mirrors FolderService pattern: cache results per (account, chat_id) for
ttl_seconds. Returns plain dicts for easy JSON serialization.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _serialize(topic: Any) -> dict[str, Any]:
    """Convert Pyrogram ForumTopic to a JSON-friendly dict."""
    last_text: Optional[str] = None
    top = getattr(topic, "top_message", None)
    if top is not None:
        last_text = (getattr(top, "text", None) or getattr(top, "caption", None) or "").strip() or None
    return {
        "topic_id": int(getattr(topic, "id", 0) or 0),
        "title": getattr(topic, "title", "") or "",
        "icon_color": getattr(topic, "icon_color", None),
        "icon_emoji_id": getattr(topic, "icon_emoji_id", None),
        "unread_count": int(getattr(topic, "unread_count", 0) or 0),
        "last_message_text": last_text,
    }


class TopicsService:
    def __init__(self, manager: Any, ttl_seconds: int = 60) -> None:
        self._manager = manager
        self._ttl = ttl_seconds
        self._cache: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}

    def _client_for(self, account: str):
        if account:
            return self._manager.get_or_create(account)
        return self._manager.default

    async def get_topics(self, account: str, chat_id: int) -> list[dict[str, Any]]:
        key = ((account or "").strip(), int(chat_id))
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and (now - cached[0]) < self._ttl:
            return cached[1]

        client = self._client_for(key[0])
        await self._manager.ensure_connected(client)

        try:
            topics: list[dict[str, Any]] = []
            async for t in client.get_forum_topics(chat_id):
                topics.append(_serialize(t))
        except Exception:
            logger.warning("get_forum_topics failed for chat_id=%s account=%r", chat_id, key[0], exc_info=True)
            topics = []

        self._cache[key] = (now, topics)
        return topics

    async def get_topic_title(self, account: str, chat_id: int, topic_id: int) -> Optional[str]:
        topics = await self.get_topics(account=account, chat_id=chat_id)
        for t in topics:
            if t["topic_id"] == int(topic_id):
                return t["title"]
        return None

    def invalidate(self, account: str = "", chat_id: Optional[int] = None) -> None:
        if chat_id is None:
            for k in list(self._cache.keys()):
                if k[0] == (account or "").strip():
                    self._cache.pop(k, None)
        else:
            self._cache.pop(((account or "").strip(), int(chat_id)), None)
```

- [ ] **Step 4: Run test to verify it passes**

```
cd backend && python -m pytest tests/test_topics_service.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```
git add backend/services/topics_service.py backend/tests/test_topics_service.py
git commit -m "feat(services): TopicsService with TTL cache around get_forum_topics"
```

---

## Task 3: Topics router

**Files:**
- Create: `backend/routers/topics.py`
- Create: `backend/tests/test_topics_api.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_topics_api.py`:

```python
"""Tests for /topics endpoint."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.topics import make_router


class _FakeTopics:
    def __init__(self, data):
        self._data = data
        self.calls = []

    async def get_topics(self, account: str, chat_id: int):
        self.calls.append((account, chat_id))
        if isinstance(self._data, Exception):
            raise self._data
        return self._data


class _FakeAuth:
    async def get_authorized_client(self, account: str):
        return object()


def _app(topics_service):
    app = FastAPI()
    app.include_router(make_router(topics_service=topics_service, auth=_FakeAuth()))
    return TestClient(app)


def test_topics_returns_serialized_list():
    topics = _FakeTopics([
        {"topic_id": 1, "title": "General", "icon_color": 9367192, "icon_emoji_id": None,
         "unread_count": 0, "last_message_text": None},
    ])
    client = _app(topics)
    r = client.get("/topics?chat_id=-100123")
    assert r.status_code == 200
    assert r.json() == {
        "chat_id": -100123,
        "topics": [
            {"topic_id": 1, "title": "General", "icon_color": 9367192, "icon_emoji_id": None,
             "unread_count": 0, "last_message_text": None},
        ],
    }


def test_topics_passes_account_query():
    topics = _FakeTopics([])
    client = _app(topics)
    client.get("/topics?chat_id=-100123&account=%2B79991234567")
    assert topics.calls == [("+79991234567", -100123)]


def test_topics_returns_404_when_chat_id_missing():
    topics = _FakeTopics([])
    client = _app(topics)
    r = client.get("/topics")
    assert r.status_code == 422  # FastAPI validation
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_topics_api.py -v
```

Expected: `ModuleNotFoundError: No module named 'routers.topics'`.

- [ ] **Step 3: Implement router**

Create `backend/routers/topics.py`:

```python
"""GET /topics — list forum topics for a supergroup."""
from __future__ import annotations

from fastapi import APIRouter

from deps.auth import AuthDeps
from services.topics_service import TopicsService


def make_router(topics_service: TopicsService, auth: AuthDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/topics")
    async def get_topics(chat_id: int, account: str = ""):
        # Ensures the account's client is authorized; raises 401 otherwise.
        await auth.get_authorized_client(account)
        topics = await topics_service.get_topics(account=account, chat_id=int(chat_id))
        return {"chat_id": int(chat_id), "topics": topics}

    return router
```

- [ ] **Step 4: Run test to verify it passes**

```
cd backend && python -m pytest tests/test_topics_api.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add backend/routers/topics.py backend/tests/test_topics_api.py
git commit -m "feat(api): GET /topics endpoint backed by TopicsService"
```

---

## Task 4: Wire TopicsService + router and outgoing handler in main.py

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/deps/pyrogram_clients.py`

- [ ] **Step 1: Read pyrogram_clients to find handler factory hooks**

```
cd backend && grep -n "set_incoming_handler_factory\|incoming_handler\|add_handler\|MessageHandler" deps/pyrogram_clients.py
```

Confirm the file already has `set_incoming_handler_factory` and a per-account hook in `get_or_create`.

- [ ] **Step 2: Add outgoing-handler factory hook to PyrogramClientManager**

Edit `backend/deps/pyrogram_clients.py`. Add right next to the existing `set_incoming_handler_factory` and where `add_handler(MessageHandler(handler, filters.incoming & ~filters.service))` is called:

```python
# In __init__:
self._outgoing_handler_factory = None

# Public setter:
def set_outgoing_handler_factory(self, factory):
    self._outgoing_handler_factory = factory

# In get_or_create, after adding the incoming handler:
if self._outgoing_handler_factory is not None:
    out_handler = self._outgoing_handler_factory(client, account)
    client.add_handler(MessageHandler(out_handler, filters.outgoing & ~filters.service))
```

Find the exact insertion site (around the existing `client.add_handler(MessageHandler(handler, filters.incoming & ~filters.service))` block) and mirror the structure.

- [ ] **Step 3: Wire TopicsService + outgoing handler + topics router in main.py**

Edit `backend/main.py`. After the existing `folder_service = FolderService(manager)`, add:

```python
from handlers.outgoing import make_outgoing_handler
from routers import topics as topics_router
from services.queue_meta_cache import QueueMetaCache  # Task 5
from services.topics_service import TopicsService

topics_service = TopicsService(manager)
queue_meta_cache = QueueMetaCache(ttl_seconds=30)
```

After `manager.set_incoming_handler_factory(...)`:

```python
manager.set_outgoing_handler_factory(
    lambda client, account: make_outgoing_handler(
        queue_service, broadcaster, account, queue_meta_cache=queue_meta_cache,
    )
)

# Default-account outgoing handler (mirrors the default-account incoming wiring below).
_default_out_handler = make_outgoing_handler(
    queue_service, broadcaster, "", queue_meta_cache=queue_meta_cache,
)
manager.default.add_handler(
    MessageHandler(_default_out_handler, filters.outgoing & ~filters.service)
)
```

Then in the routers registration block:

```python
app.include_router(topics_router.make_router(topics_service=topics_service, auth=auth_deps))
```

- [ ] **Step 4: Smoke test — start the app**

```
cd backend && python -m uvicorn main:app --port 18080 --no-access-log &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/healthz
kill %1
```

Expected: `200`.

- [ ] **Step 5: Commit**

```
git add backend/main.py backend/deps/pyrogram_clients.py
git commit -m "feat(app): register TopicsService, outgoing handler, /topics router"
```

> Note: this task references `services/queue_meta_cache.py` defined in Task 5. If the implementer is executing strictly in order, run Task 5 first (create the empty module) or temporarily comment the `queue_meta_cache` lines. The recommended order is **Task 5 → Task 4** if executing manually; subagent-driven mode handles this fine because the steps are independent.

---

## Task 5: QueueMetaCache (TtlCache wrapper for last-message snapshots)

**Files:**
- Create: `backend/services/queue_meta_cache.py`
- Create: `backend/tests/test_queue_meta_cache.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_queue_meta_cache.py`:

```python
"""Tests for QueueMetaCache (per-(account,chat_id) last_message TTL cache)."""
from __future__ import annotations

import asyncio

from services.queue_meta_cache import QueueMetaCache


async def test_set_and_get():
    c = QueueMetaCache(ttl_seconds=60)
    c.set("acc", 100, {"id": 1, "text": "hi"})
    assert c.get("acc", 100) == {"id": 1, "text": "hi"}


async def test_get_returns_none_on_miss():
    c = QueueMetaCache(ttl_seconds=60)
    assert c.get("acc", 100) is None


async def test_invalidate_chat():
    c = QueueMetaCache(ttl_seconds=60)
    c.set("acc", 100, {"id": 1})
    c.set("acc", 200, {"id": 2})
    c.invalidate("acc", 100)
    assert c.get("acc", 100) is None
    assert c.get("acc", 200) == {"id": 2}


async def test_invalidate_account_clears_all():
    c = QueueMetaCache(ttl_seconds=60)
    c.set("acc1", 100, {"id": 1})
    c.set("acc2", 100, {"id": 2})
    c.invalidate("acc1")
    assert c.get("acc1", 100) is None
    assert c.get("acc2", 100) == {"id": 2}


async def test_ttl_expiry():
    c = QueueMetaCache(ttl_seconds=0)  # immediate expiry
    c.set("acc", 100, {"id": 1})
    await asyncio.sleep(0.01)
    assert c.get("acc", 100) is None
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_queue_meta_cache.py -v
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement QueueMetaCache**

Create `backend/services/queue_meta_cache.py`:

```python
"""Per-(account, chat_id) TTL cache for queue last-message snapshots.

Used by /queue?meta=true to avoid hammering Telegram on every poll.
"""
from __future__ import annotations

import time
from typing import Any, Optional


class QueueMetaCache:
    def __init__(self, ttl_seconds: int = 30) -> None:
        self._ttl = ttl_seconds
        self._store: dict[tuple[str, int], tuple[float, Any]] = {}

    def get(self, account: str, chat_id: int) -> Optional[Any]:
        key = ((account or "").strip(), int(chat_id))
        item = self._store.get(key)
        if not item:
            return None
        ts, value = item
        if (time.monotonic() - ts) > self._ttl:
            self._store.pop(key, None)
            return None
        return value

    def set(self, account: str, chat_id: int, value: Any) -> None:
        key = ((account or "").strip(), int(chat_id))
        self._store[key] = (time.monotonic(), value)

    def invalidate(self, account: str = "", chat_id: Optional[int] = None) -> None:
        norm = (account or "").strip()
        if chat_id is None:
            for k in list(self._store.keys()):
                if k[0] == norm:
                    self._store.pop(k, None)
        else:
            self._store.pop((norm, int(chat_id)), None)
```

- [ ] **Step 4: Run test to verify it passes**

```
cd backend && python -m pytest tests/test_queue_meta_cache.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```
git add backend/services/queue_meta_cache.py backend/tests/test_queue_meta_cache.py
git commit -m "feat(services): QueueMetaCache for /queue meta last-message snapshots"
```

---

## Task 6: Enrich `/queue?meta=true` with last_message + topic info

**Files:**
- Modify: `backend/routers/queue.py`
- Create: `backend/tests/test_queue_meta_extended.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_queue_meta_extended.py`:

```python
"""Tests for /queue?meta=true with last_message and topic enrichment."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.queue import make_router
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService


class _FakeFolders:
    async def get_folders(self, account: str = ""):
        return {"chat_to_folders": {100: [2]}}


class _FakeTopics:
    def __init__(self, mapping):
        self._m = mapping

    async def get_topic_title(self, account, chat_id, topic_id):
        return self._m.get((chat_id, topic_id))


def _msg(mid, text, thread_id=None, from_first="Ivan"):
    return SimpleNamespace(
        id=mid, text=text, caption=None,
        date=datetime(2026, 5, 8, 12, 0),
        from_user=SimpleNamespace(id=1, first_name=from_first, last_name=None),
        sender_chat=None, outgoing=False,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        message_thread_id=thread_id,
    )


class _FakeManager:
    def __init__(self, history_by_chat):
        self._h = history_by_chat
        self.default = self
        self.get_or_create = lambda _a: self
        async def _ensure(client): return None
        self.ensure_connected = _ensure

    async def get_chat_history(self, chat_id, limit=1):
        async def gen():
            for m in self._h.get(chat_id, [])[:limit]:
                yield m
        return gen()


async def test_meta_returns_last_message_with_author_and_topic():
    qs = QueueService()
    await qs.add("", 100)
    cache = QueueMetaCache(ttl_seconds=30)
    topics = _FakeTopics({(100, 7): "General"})

    fake_history = {100: [_msg(50, "hello world", thread_id=7, from_first="Ivan")]}
    fake_mgr = _FakeManager(fake_history)

    app = FastAPI()
    app.include_router(
        make_router(
            manager=fake_mgr,
            auth=MagicMock(),
            queue_service=qs,
            folder_service=_FakeFolders(),
            topics_service=topics,
            queue_meta_cache=cache,
        )
    )
    client = TestClient(app)

    r = client.get("/queue?meta=true")
    assert r.status_code == 200
    data = r.json()
    assert len(data["queue"]) == 1
    item = data["queue"][0]
    assert item["chat_id"] == 100
    assert item["topic_id"] == 7
    assert item["topic_title"] == "General"
    last = item["last_message"]
    assert last["text"] == "hello world"
    assert last["from_name"] == "Ivan"
    assert last["outgoing"] is False


async def test_meta_uses_cache_on_second_call():
    qs = QueueService()
    await qs.add("", 100)
    cache = QueueMetaCache(ttl_seconds=30)
    cache.set("", 100, {"id": 99, "text": "cached", "from_name": None, "outgoing": False, "date": 0, "topic_id": None})

    # Manager that would error if called — proves cache short-circuit.
    class _Boom:
        default = None
        get_or_create = staticmethod(lambda _a: None)
        async def ensure_connected(self, _c): raise AssertionError("should not connect")
        async def get_chat_history(self, *a, **kw): raise AssertionError("should not be called")

    app = FastAPI()
    app.include_router(
        make_router(
            manager=_Boom(),
            auth=MagicMock(),
            queue_service=qs,
            folder_service=_FakeFolders(),
            topics_service=_FakeTopics({}),
            queue_meta_cache=cache,
        )
    )
    client = TestClient(app)
    r = client.get("/queue?meta=true")
    assert r.status_code == 200
    item = r.json()["queue"][0]
    assert item["last_message"]["text"] == "cached"
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_queue_meta_extended.py -v
```

Expected: `TypeError: make_router() got an unexpected keyword argument 'topics_service'`.

- [ ] **Step 3: Implement the router enrichment**

Replace `backend/routers/queue.py` with:

```python
"""Queue endpoints: list and act on pending chats."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

from deps.auth import AuthDeps
from deps.pyrogram_clients import PyrogramClientManager
from services.folder_service import FolderService
from services.queue_meta_cache import QueueMetaCache
from services.queue_service import QueueService
from services.topics_service import TopicsService

logger = logging.getLogger(__name__)


def _format_author(m) -> Optional[str]:
    if getattr(m, "from_user", None):
        first = getattr(m.from_user, "first_name", None) or ""
        last = getattr(m.from_user, "last_name", None) or ""
        return (first + (" " + last if last else "")).strip() or None
    if getattr(m, "sender_chat", None):
        return getattr(m.sender_chat, "title", None)
    return None


async def _fetch_last_message(
    client, chat_id: int, topics_service: TopicsService, account: str
) -> Optional[dict[str, Any]]:
    try:
        async for m in client.get_chat_history(chat_id, limit=1):
            text = (getattr(m, "text", None) or getattr(m, "caption", None) or "").strip() or None
            topic_id = getattr(m, "message_thread_id", None)
            return {
                "id": getattr(m, "id", 0),
                "text": text,
                "from_name": _format_author(m) if not getattr(m, "outgoing", False) else None,
                "outgoing": bool(getattr(m, "outgoing", False)),
                "date": int(m.date.timestamp()) if getattr(m, "date", None) else None,
                "topic_id": int(topic_id) if topic_id else None,
            }
    except Exception:
        logger.debug("get_chat_history(limit=1) failed for chat %s", chat_id, exc_info=True)
    return None


def make_router(
    manager: PyrogramClientManager,
    auth: AuthDeps,
    queue_service: QueueService,
    folder_service: FolderService,
    topics_service: TopicsService,
    queue_meta_cache: QueueMetaCache,
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
        snoozed = await queue_service.snoozed(account)

        # Resolve last_message per chat: try cache; fall back to one Pyrogram call each.
        client = manager.get_or_create(account) if account else manager.default

        async def _resolve(cid: int) -> dict[str, Any]:
            cached = queue_meta_cache.get(account, cid)
            if cached is not None:
                last = cached
            else:
                if client is not None:
                    try:
                        await manager.ensure_connected(client)
                    except Exception:
                        pass
                last = await _fetch_last_message(client, cid, topics_service, account) if client else None
                if last is not None:
                    queue_meta_cache.set(account, cid, last)
            topic_id = last.get("topic_id") if last else None
            topic_title = None
            if topic_id is not None:
                try:
                    topic_title = await topics_service.get_topic_title(
                        account=account, chat_id=cid, topic_id=int(topic_id)
                    )
                except Exception:
                    topic_title = None
            return {
                "chat_id": cid,
                "folder_ids": list(c2f.get(cid, [])),
                "snooze_until": None,
                "topic_id": topic_id,
                "topic_title": topic_title,
                "last_message": last,
            }

        items = await asyncio.gather(*[_resolve(cid) for cid in order])
        return {
            "queue": items,
            "snoozed": [
                {"chat_id": cid, "snooze_until": ts}
                for cid, ts in sorted(snoozed.items(), key=lambda kv: kv[1])
            ],
        }

    @router.post("/queue/action")
    async def queue_action(payload: dict[str, Any]):
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
            queue_meta_cache.invalidate(account, int(chat_id))
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
            queue_meta_cache.invalidate(account, int(chat_id))
        else:
            await queue_service.move_to_end(account, chat_id)

        order = await queue_service.get(account)
        next_chat_id = order[0] if order else None
        return {"ok": True, "next_chat_id": next_chat_id, "queue": order}

    return router
```

- [ ] **Step 4: Update main.py to pass new deps**

In `backend/main.py`, find the existing line:

```python
app.include_router(queue_router.make_router(manager, auth_deps, queue_service, folder_service))
```

Replace with:

```python
app.include_router(
    queue_router.make_router(
        manager=manager,
        auth=auth_deps,
        queue_service=queue_service,
        folder_service=folder_service,
        topics_service=topics_service,
        queue_meta_cache=queue_meta_cache,
    )
)
```

- [ ] **Step 5: Run tests**

```
cd backend && python -m pytest tests/test_queue_meta_extended.py tests/test_queue_api.py tests/test_queue_meta_snooze.py tests/test_queue_action_snooze.py -v
```

Expected: all pass. The existing `test_queue_api.py` calls `make_router` with old positional args — update that test to pass the two new kwargs (use `MagicMock()` for `topics_service` and a real `QueueMetaCache` instance).

- [ ] **Step 6: Commit**

```
git add backend/routers/queue.py backend/main.py backend/tests/test_queue_meta_extended.py backend/tests/test_queue_api.py
git commit -m "feat(api): /queue?meta=true returns last_message + topic info, cached"
```

---

## Task 7: incoming.py emits topic_id/topic_title and invalidates queue_meta_cache

**Files:**
- Modify: `backend/handlers/incoming.py`
- Modify: `backend/tests/test_incoming_handler.py` (or create `test_incoming_topics.py`)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_incoming_topics.py`:

```python
"""Incoming handler enriches broadcast with topic info and invalidates cache."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from handlers.incoming import make_incoming_handler
from services.queue_service import QueueService


class _FakeFolderService:
    def is_archived(self, account, chat_id): return False
    def get_cached_chat_folders(self, account, chat_id): return [2]


class _FakeTopicsService:
    def __init__(self, title): self._title = title
    async def get_topic_title(self, account, chat_id, topic_id): return self._title


def _msg(thread_id):
    return SimpleNamespace(
        chat=SimpleNamespace(id=-100123, type=SimpleNamespace(value="supergroup"), title="Forum"),
        text="hi", caption=None, date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=1, first_name="A", last_name=None),
        sender_chat=None, outgoing=False,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        id=10, message_thread_id=thread_id,
    )


async def test_handler_includes_topic_info_in_broadcasts():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_incoming_handler(
        queue_service=qs, broadcaster=bcast, account="",
        folder_service=_FakeFolderService(),
        topics_service=_FakeTopicsService("General"),
        queue_meta_cache=cache,
    )

    await handler(client=MagicMock(), message=_msg(thread_id=7))

    # Two broadcasts: queue_update + message
    assert bcast.broadcast.await_count == 2
    qu, msg = bcast.broadcast.call_args_list
    qu_payload = qu.args[0]
    msg_payload = msg.args[0]
    assert qu_payload["topic_id"] == 7
    assert msg_payload["topic_id"] == 7
    assert msg_payload["topic_title"] == "General"
    cache.invalidate.assert_called_once_with("", -100123)


async def test_handler_topic_id_none_for_non_forum():
    qs = QueueService()
    bcast = MagicMock(); bcast.broadcast = AsyncMock()
    cache = MagicMock(); cache.invalidate = MagicMock()
    handler = make_incoming_handler(
        queue_service=qs, broadcaster=bcast, account="",
        folder_service=_FakeFolderService(),
        topics_service=_FakeTopicsService(None),
        queue_meta_cache=cache,
    )

    await handler(client=MagicMock(), message=_msg(thread_id=None))

    msg_payload = bcast.broadcast.call_args_list[1].args[0]
    assert msg_payload["topic_id"] is None
    assert msg_payload["topic_title"] is None
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_incoming_topics.py -v
```

Expected: `TypeError: make_incoming_handler() got an unexpected keyword argument 'topics_service'`.

- [ ] **Step 3: Update incoming handler**

Replace `backend/handlers/incoming.py` with:

```python
"""Factory for Pyrogram incoming-message handlers.

Accepts private + group + supergroup chats. Channels (broadcast) and archived
chats are skipped. Forum-supergroup messages also carry topic_id and
topic_title (best-effort, from TopicsService cache).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

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
    topics_service: Optional[Any] = None,
    queue_meta_cache: Optional[Any] = None,
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
        if queue_meta_cache is not None:
            try:
                queue_meta_cache.invalidate(account, chat_id)
            except Exception:
                logger.debug("queue_meta_cache invalidate failed", exc_info=True)

        topic_id = getattr(message, "message_thread_id", None)
        topic_id_int = int(topic_id) if topic_id else None
        topic_title: Optional[str] = None
        if topic_id_int is not None and topics_service is not None:
            try:
                topic_title = await topics_service.get_topic_title(
                    account=account, chat_id=chat_id, topic_id=topic_id_int
                )
            except Exception:
                topic_title = None

        folder_ids = folder_service.get_cached_chat_folders(account, chat_id)
        await broadcaster.broadcast(
            {
                "type": "queue_update",
                "account": account,
                "chat_id": chat_id,
                "folder_ids": folder_ids,
                "topic_id": topic_id_int,
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
                    "topic_id": topic_id_int,
                    "topic_title": topic_title,
                    "message": payload,
                }
            )

    return handler


def _format_author(message: Message) -> Optional[str]:
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

- [ ] **Step 4: Update main.py to pass new kwargs**

In `backend/main.py`, find:

```python
manager.set_incoming_handler_factory(
    lambda client, account: make_incoming_handler(queue_service, broadcaster, account, folder_service)
)
```

Replace with:

```python
manager.set_incoming_handler_factory(
    lambda client, account: make_incoming_handler(
        queue_service=queue_service, broadcaster=broadcaster, account=account,
        folder_service=folder_service, topics_service=topics_service,
        queue_meta_cache=queue_meta_cache,
    )
)
```

And mirror the change for the default-account handler (`_default_handler = make_incoming_handler(...)`).

- [ ] **Step 5: Run all incoming-handler tests**

```
cd backend && python -m pytest tests/test_incoming_handler.py tests/test_incoming_topics.py -v
```

Expected: existing tests still pass (new kwargs are optional), new ones pass too.

- [ ] **Step 6: Commit**

```
git add backend/handlers/incoming.py backend/main.py backend/tests/test_incoming_topics.py
git commit -m "feat(handlers): incoming carries topic_id/topic_title; invalidates queue meta"
```

---

## Task 8: /messages accepts topic_id; /send_message accepts message_thread_id

**Files:**
- Modify: `backend/routers/messages.py`
- Create: `backend/tests/test_messages_topic_id.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_messages_topic_id.py`:

```python
"""Tests for topic_id forwarding through /messages and /send_message."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


class _Auth:
    def __init__(self, client): self._client = client
    async def get_authorized_client(self, account): return self._client


class _Manager:
    def __init__(self, client):
        self._client = client
        self.default = client
    def get_or_create(self, account): return self._client
    async def ensure_connected(self, c): return None


def _msg(mid=1):
    return SimpleNamespace(
        id=mid, text="hello", caption=None,
        date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=1, first_name="A", last_name=None),
        sender_chat=None, outgoing=False,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        chat=SimpleNamespace(id=-100123),
    )


def test_get_messages_passes_topic_id_to_pyrogram():
    captured = {}

    async def fake_history(chat_id, limit, **kwargs):
        captured.update({"chat_id": chat_id, "limit": limit, **kwargs})
        async def gen():
            yield _msg(1)
        async for m in gen():
            yield m

    client = MagicMock()
    client.get_chat_history = fake_history

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.get("/messages?chat_id=-100123&topic_id=7&limit=10")
    assert r.status_code == 200
    assert captured["chat_id"] == -100123
    assert captured["limit"] == 10
    assert captured["message_thread_id"] == 7


def test_send_message_passes_message_thread_id():
    sent = {}
    async def fake_send(chat_id, text, **kwargs):
        sent.update({"chat_id": chat_id, "text": text, **kwargs})
        return SimpleNamespace(id=999)

    client = MagicMock()
    client.send_message = fake_send

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.post("/send_message", json={
        "chat_id": -100123, "text": "hi", "message_thread_id": 7,
    })
    assert r.status_code == 200
    assert sent["message_thread_id"] == 7
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_messages_topic_id.py -v
```

Expected: 2 failures (no topic_id forwarding yet).

- [ ] **Step 3: Modify routers/messages.py**

In `backend/routers/messages.py`, modify `get_messages` and `api_send_message` signatures:

```python
@router.get("/messages")
async def get_messages(
    chat_id: int,
    limit: int = 50,
    before_id: Optional[int] = None,
    topic_id: Optional[int] = None,   # NEW
    account: str = "",
):
    client = await auth.get_authorized_client(account)
    history: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"limit": limit}
    if before_id:
        try:
            kwargs["max_id"] = int(before_id) - 1
        except Exception:
            logger.debug("invalid before_id value %r", before_id, exc_info=True)
    if topic_id is not None:
        kwargs["message_thread_id"] = int(topic_id)   # NEW
    async for m in client.get_chat_history(chat_id, **kwargs):
        # ... unchanged loop body
```

Repeat the same `topic_id` addition to `/messages/since` (it should also forward `message_thread_id` when present).

In `api_send_message`, add:

```python
@router.post("/send_message")
async def api_send_message(payload: dict[str, Any]):
    account = str(payload.get("account", "")).strip()
    chat_id = payload.get("chat_id")
    text = payload.get("text")
    reply_to_message_id = payload.get("reply_to_message_id")
    message_thread_id = payload.get("message_thread_id")   # NEW
    if chat_id is None or not text:
        raise HTTPException(status_code=400, detail="chat_id and text are required")
    client = manager.get_or_create(account) if account else manager.default
    await manager.ensure_connected(client)
    try:
        kwargs: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if reply_to_message_id is not None:
            kwargs["reply_to_message_id"] = reply_to_message_id
        if message_thread_id is not None:
            kwargs["message_thread_id"] = int(message_thread_id)   # NEW
        sent = await client.send_message(**kwargs)
        return {"ok": True, "message_id": sent.id}
    except Exception as e:
        logger.warning("send_message to chat %s failed: %s", chat_id, e)
        raise HTTPException(status_code=400, detail=str(e))
```

- [ ] **Step 4: Run tests**

```
cd backend && python -m pytest tests/test_messages_topic_id.py tests/test_messages_since.py -v
```

Expected: pass.

- [ ] **Step 5: Commit**

```
git add backend/routers/messages.py backend/tests/test_messages_topic_id.py
git commit -m "feat(api): /messages accepts topic_id; /send_message accepts message_thread_id"
```

---

## Task 9: dialogs.py emits is_forum

**Files:**
- Modify: `backend/routers/dialogs.py`
- Modify: `backend/tests/test_dialogs_logic.py` (add a case)

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_dialogs_logic.py`, add:

```python
def test_map_dialog_emits_is_forum_true_for_supergroup_with_is_forum_attr():
    from routers.dialogs import _map_dialog
    chat = SimpleNamespace(
        id=-100123, type=SimpleNamespace(value="supergroup"),
        title="Forum", first_name=None, last_name=None,
        username=None, is_forum=True,
    )
    d = SimpleNamespace(chat=chat, top_message=None,
                        unread_messages_count=0, folder_id=0)
    result = _map_dialog(d)
    assert result["is_forum"] is True


def test_map_dialog_emits_is_forum_false_when_attr_missing():
    from routers.dialogs import _map_dialog
    chat = SimpleNamespace(
        id=200, type=SimpleNamespace(value="private"),
        title=None, first_name="A", last_name="B",
        username=None,
    )
    d = SimpleNamespace(chat=chat, top_message=None,
                        unread_messages_count=0, folder_id=0)
    result = _map_dialog(d)
    assert result["is_forum"] is False
```

(Add `from types import SimpleNamespace` if not already imported.)

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_dialogs_logic.py -v -k is_forum
```

Expected: KeyError or AssertionError.

- [ ] **Step 3: Modify _map_dialog**

In `backend/routers/dialogs.py`, in `_map_dialog`, before the final `return`:

```python
return {
    "chat_id": chat.id,
    "title": title,
    "type": type_name,
    "username": getattr(chat, "username", None),
    "unread_count": getattr(d, "unread_messages_count", 0),
    "last_message_text": last_text,
    "folder_id": folder_id,
    "is_forum": bool(getattr(chat, "is_forum", False)),   # NEW
}
```

- [ ] **Step 4: Run tests**

```
cd backend && python -m pytest tests/test_dialogs_logic.py -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```
git add backend/routers/dialogs.py backend/tests/test_dialogs_logic.py
git commit -m "feat(api): /dialogs returns is_forum flag for forum-supergroups"
```

---

## Task 10: Frontend types — Topic, Chat.isForum, Message.topicId

**Files:**
- Modify: `frontend/src/types/telegram.ts`

- [ ] **Step 1: Edit types/telegram.ts**

```typescript
export interface Chat {
  id: number;
  title: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  photo?: string;
  unreadCount?: number;
  lastMessage?: Message;
  isOnline?: boolean;
  isForum?: boolean;          // NEW
}

export interface Topic {       // NEW
  topicId: number;
  title: string;
  iconColor?: number;
  iconEmojiId?: string | null;
  unreadCount: number;
  lastMessageText: string | null;
}

export type MediaType = 'photo' | 'video' | 'voice' | 'document';

export interface Message {
  id: number;
  chatId: number;
  senderId: number;
  senderName?: string;
  text: string;
  date: Date;
  isOutgoing: boolean;
  replyToMessage?: Message;
  edited?: boolean;
  mediaType?: MediaType;
  mediaUrl?: string;
  fileName?: string;
  duration?: number;
  topicId?: number;            // NEW
}
```

- [ ] **Step 2: Type-check**

```
cd frontend && npx tsc --noEmit
```

Expected: no new errors. Existing files won't break — fields are optional.

- [ ] **Step 3: Commit**

```
git add frontend/src/types/telegram.ts
git commit -m "feat(types): add Topic, Chat.isForum, Message.topicId"
```

---

## Task 11: Frontend API — getTopics, topic_id pass-through

**Files:**
- Modify: `frontend/src/services/telegramApi.ts`

- [ ] **Step 1: Add getTopics method**

In `frontend/src/services/telegramApi.ts`, add a new method (place it near `getChatInfo`):

```typescript
async getTopics(chatId: number): Promise<import('@/types/telegram').Topic[]> {
  if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
  const res = await this.fetchJson(`/topics?chat_id=${encodeURIComponent(chatId)}`);
  return (res.topics || []).map((t: any) => ({
    topicId: t.topic_id,
    title: t.title,
    iconColor: t.icon_color,
    iconEmojiId: t.icon_emoji_id,
    unreadCount: t.unread_count,
    lastMessageText: t.last_message_text,
  }));
}
```

- [ ] **Step 2: Update getMessages / getOlderMessages / sendMessage to accept topic_id**

In `getMessages`:

```typescript
async getMessages(chatId: number, limit: number = 100, topicId?: number): Promise<Message[]> {
  if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
  const params = new URLSearchParams();
  params.set('chat_id', String(chatId));
  params.set('limit', String(limit));
  if (topicId !== undefined) params.set('topic_id', String(topicId));
  const res = await this.fetchJson(`/messages?${params.toString()}`);
  return (res.messages || []).map((m: any) => this.mapMessage(m, res.chat_id));
}
```

Mirror the same pattern in `getOlderMessages` (add `topicId?` as 4th arg, append to params), and update `mapMessage` to read `m.message_thread_id` into `msg.topicId` if present:

```typescript
private mapMessage(m: any, chatId: number): Message {
  const msg: Message = {
    id: m.id,
    chatId,
    senderId: m.from_user_id || 0,
    senderName: m.from_user_name || undefined,
    text: m.text || '',
    date: m.date ? new Date(m.date * 1000) : new Date(),
    isOutgoing: !!m.outgoing,
  };
  if (m.media_type) {
    msg.mediaType = m.media_type as MediaType;
    msg.mediaUrl = m.media_url ? this.baseUrl + this.withAccountQuery(m.media_url) : undefined;
    if (m.file_name) msg.fileName = m.file_name;
    if (m.duration != null) msg.duration = m.duration;
  }
  if (m.message_thread_id != null) msg.topicId = m.message_thread_id;
  return msg;
}
```

In `sendMessage`:

```typescript
async sendMessage(chatId: number, text: string, topicId?: number): Promise<Message> {
  if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
  const body: Record<string, any> = { chat_id: chatId, text };
  if (topicId !== undefined) body.message_thread_id = topicId;
  await this.fetchJson('/send_message', { method: 'POST', body: JSON.stringify(body) });
  const currentUser = await this.getCurrentUser();
  return {
    id: Date.now(),
    chatId,
    senderId: currentUser.id,
    text,
    date: new Date(),
    isOutgoing: true,
    topicId,
  };
}
```

- [ ] **Step 3: Update mapDialogToChat to read is_forum**

Find `mapDialogToChat` (search the file) and add:

```typescript
return {
  id: d.chat_id,
  title: d.title,
  type: d.type,
  unreadCount: d.unread_count,
  isForum: !!d.is_forum,   // NEW
};
```

- [ ] **Step 4: Type-check**

```
cd frontend && npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 5: Commit**

```
git add frontend/src/services/telegramApi.ts
git commit -m "feat(api-client): getTopics, topic_id in messages/sendMessage, isForum in chats"
```

---

## Task 12: TopicsPage + route

**Files:**
- Create: `frontend/src/pages/TopicsPage.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Locate the routes definition**

```
cd frontend && grep -n "Route\b\|Routes\b\|/chat/" src/App.tsx
```

Confirm there is a `<Route path="/chat/:chatId" ... />` already present.

- [ ] **Step 2: Create TopicsPage**

Create `frontend/src/pages/TopicsPage.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { telegramApi } from "@/services/telegramApi";
import type { Topic } from "@/types/telegram";

export default function TopicsPage() {
  const navigate = useNavigate();
  const { chatId: chatIdRaw } = useParams();
  const chatId = parseInt(chatIdRaw || "0", 10);
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState<string>("");

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    (async () => {
      try {
        const [info, t] = await Promise.all([
          telegramApi.getChatInfo(chatId).catch(() => null),
          telegramApi.getTopics(chatId),
        ]);
        if (cancelled) return;
        if (info) setChatTitle(info.title);
        setTopics(t);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Ошибка загрузки тем");
      }
    })();
    return () => { cancelled = true; };
  }, [chatId]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-10 bg-background border-b border-border p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/message")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold truncate">{chatTitle || "Темы"}</h1>
      </div>

      <div className="p-4 space-y-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {topics === null && !error && <p className="text-sm text-muted-foreground">Загрузка...</p>}
        {topics && topics.length === 0 && (
          <p className="text-sm text-muted-foreground">В этой группе пока нет тем.</p>
        )}
        {topics?.map((t) => (
          <Card
            key={t.topicId}
            className="p-3 cursor-pointer hover:bg-muted/30 transition"
            onClick={() => navigate(`/chat/${chatId}?topic_id=${t.topicId}`)}
          >
            <div className="flex items-start gap-3">
              <div
                className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold text-white"
                style={{ backgroundColor: t.iconColor ? `#${t.iconColor.toString(16).padStart(6, "0")}` : "#7e8a98" }}
              >
                {t.title[0] || "#"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="font-medium truncate">{t.title}</p>
                  {t.unreadCount > 0 && (
                    <span className="ml-2 text-[10px] font-bold rounded-full bg-primary text-primary-foreground px-1.5 py-0.5">
                      {t.unreadCount}
                    </span>
                  )}
                </div>
                {t.lastMessageText && (
                  <p className="text-xs text-muted-foreground truncate">{t.lastMessageText}</p>
                )}
              </div>
              <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the route in App.tsx**

In `frontend/src/App.tsx`, add an import:

```tsx
import TopicsPage from "@/pages/TopicsPage";
```

Add a `<Route>` immediately above the existing `/chat/:chatId` route:

```tsx
<Route path="/chat/:chatId/topics" element={<TopicsPage />} />
```

- [ ] **Step 4: Smoke build**

```
cd frontend && npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```
git add frontend/src/pages/TopicsPage.tsx frontend/src/App.tsx
git commit -m "feat(frontend): TopicsPage and /chat/:id/topics route"
```

---

## Task 13: MessagePage routes forum chats to TopicsPage

**Files:**
- Modify: `frontend/src/pages/MessagePage.tsx`

- [ ] **Step 1: Locate chat-click handler**

```
cd frontend && grep -n "navigate(\`/chat\|navigate('/chat\|handleChatClick\|onClick={\(\)" src/pages/MessagePage.tsx | head
```

- [ ] **Step 2: Edit chat-click handler**

In MessagePage's row click handler (or inline `onClick` on the chat card), change navigation logic to route forums to topics:

```tsx
const handleChatClick = (chat: Chat) => {
  if (chat.isForum) {
    navigate(`/chat/${chat.id}/topics`);
  } else {
    navigate(`/chat/${chat.id}`);
  }
};
```

Replace existing `navigate(\`/chat/${id}\`)` calls inside the chat list row with `handleChatClick(chat)`.

- [ ] **Step 3: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 4: Commit**

```
git add frontend/src/pages/MessagePage.tsx
git commit -m "feat(message): route forum-supergroup taps to /chat/:id/topics"
```

---

## Task 14: ChatPage reads ?topic_id and forwards to API

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`
- Modify: `frontend/src/contexts/TelegramContext.tsx` (optional — see step 2)

- [ ] **Step 1: Read topicId from query**

At the top of `ChatPage` component, add:

```tsx
import { useSearchParams } from "react-router-dom";
// ... inside component:
const [searchParams] = useSearchParams();
const topicIdRaw = searchParams.get("topic_id");
const topicId = topicIdRaw ? parseInt(topicIdRaw, 10) : undefined;
```

- [ ] **Step 2: Forward topicId in API calls**

Find every `telegramApi.getMessages(numericChatId)` and `telegramApi.getOlderMessages(numericChatId, ...)` in this file. Append `, topicId` as the trailing argument:

```tsx
const fresh = await telegramApi.getMessages(numericChatId, 100, topicId);
const older = await telegramApi.getOlderMessages(numericChatId, beforeId, pageSize, topicId);
```

In `handleSendMessage`:

```tsx
await sendMessage(numericChatId, message.trim(), topicId);
```

`sendMessage` signature in `TelegramContext.tsx` may need its third arg added; if so, propagate it:

```tsx
const sendMessage = async (chatId: number, text: string, topicId?: number) => {
  // forward to telegramApi.sendMessage(chatId, text, topicId)
};
```

- [ ] **Step 3: Filter messages by topic in render (defensive)**

In the `messages` useMemo:

```tsx
const messages = useMemo<UiMsg[]>(() => {
  const list = state.messages[numericChatId] || [];
  const filtered = topicId === undefined
    ? list
    : list.filter(m => m.topicId === topicId);
  return filtered.map(m => ({...}));
}, [state.messages, numericChatId, isGroup, topicId]);
```

- [ ] **Step 4: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 5: Commit**

```
git add frontend/src/pages/ChatPage.tsx frontend/src/contexts/TelegramContext.tsx
git commit -m "feat(chat): ChatPage reads ?topic_id and scopes API calls + render"
```

---

## Task 15: QueueFilter component (replaces QueueFolderFilter)

**Files:**
- Create: `frontend/src/components/queue/QueueFilter.tsx`
- Delete: `frontend/src/components/queue/QueueFolderFilter.tsx`

- [ ] **Step 1: Read the existing QueueFolderFilter**

```
cat frontend/src/components/queue/QueueFolderFilter.tsx
```

Note its props/onChange signature — we'll keep `onChange(folderIds: number[])` plus add `types`.

- [ ] **Step 2: Create QueueFilter**

Create `frontend/src/components/queue/QueueFilter.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { ChipFilter, type ChipOption } from "@/components/ui-extras/ChipFilter";
import { useFolders } from "@/hooks/useFolders";

const STORAGE_KEY = "queue_filter";

export type QueueFilterState = { types: ("private" | "groups")[]; folderIds: number[] };

const TYPE_OPTIONS: ChipOption[] = [
  { id: "private", label: "Личные" },
  { id: "groups", label: "Группы" },
];

type Persisted = { types: string[]; folders: string[] };

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { types: [], folders: [] };
    const p = JSON.parse(raw);
    return {
      types: Array.isArray(p.types) ? p.types : [],
      folders: Array.isArray(p.folders) ? p.folders : [],
    };
  } catch {
    return { types: [], folders: [] };
  }
}

function savePersisted(p: Persisted) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch {}
}

export function QueueFilter({ onChange }: { onChange: (s: QueueFilterState) => void }) {
  const persisted = useMemo(loadPersisted, []);
  const [types, setTypes] = useState<string[]>(persisted.types);
  const [folderIds, setFolderIds] = useState<string[]>(persisted.folders);
  const { folders, isLoading } = useFolders();

  useEffect(() => {
    savePersisted({ types, folders: folderIds });
    onChange({
      types: types.filter((t): t is "private" | "groups" => t === "private" || t === "groups"),
      folderIds: folderIds.map((s) => Number(s)).filter((n) => Number.isFinite(n)),
    });
  }, [types, folderIds, onChange]);

  const toggle = (set: string[], setSet: (v: string[]) => void) => (id: string) =>
    setSet(set.includes(id) ? set.filter((x) => x !== id) : [...set, id]);

  const folderOptions: ChipOption[] = folders.map((f) => ({ id: String(f.id), label: f.title }));

  return (
    <div className="flex flex-col gap-2 p-3 border-b border-border">
      <ChipFilter options={TYPE_OPTIONS} selected={types} onToggle={toggle(types, setTypes)} />
      {!isLoading && folderOptions.length > 0 && (
        <ChipFilter options={folderOptions} selected={folderIds} onToggle={toggle(folderIds, setFolderIds)} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Delete QueueFolderFilter**

```
git rm frontend/src/components/queue/QueueFolderFilter.tsx
```

- [ ] **Step 4: Update QueuePage imports + state**

In `frontend/src/pages/QueuePage.tsx`:

```tsx
// Remove:
import { QueueFolderFilter } from '@/components/queue/QueueFolderFilter';

// Add:
import { QueueFilter, type QueueFilterState } from '@/components/queue/QueueFilter';

// Replace state:
const [folderFilter, setFolderFilter] = useState<number[]>([]);

// With:
const [filter, setFilter] = useState<QueueFilterState>({ types: [], folderIds: [] });

// Replace visibleQueueIds memo:
const visibleQueueIds = useMemo(() => {
  return queueIds.filter((cid) => {
    const chat = state.chats.find(c => c.id === cid);
    if (filter.types.length > 0) {
      const isPrivate = chat?.type === 'private';
      const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';
      const matchesType =
        (filter.types.includes('private') && isPrivate) ||
        (filter.types.includes('groups') && isGroup);
      if (!matchesType) return false;
    }
    if (filter.folderIds.length > 0) {
      const chatFolders = chatToFolders.get(cid) ?? [];
      if (!chatFolders.some(id => filter.folderIds.includes(id))) return false;
    }
    return true;
  });
}, [queueIds, filter, chatToFolders, state.chats]);
```

Replace the `<QueueFolderFilter onChange={setFolderFilter} />` JSX with `<QueueFilter onChange={setFilter} />`.

- [ ] **Step 5: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 6: Commit**

```
git add frontend/src/components/queue/QueueFilter.tsx frontend/src/pages/QueuePage.tsx
git commit -m "feat(queue): QueueFilter (types + folders); remove QueueFolderFilter"
```

---

## Task 16: QueuePage UI fixes — header, TaskFromChatForm key, author/topic on card

**Files:**
- Modify: `frontend/src/pages/QueuePage.tsx`
- Modify: `frontend/src/components/queue/QueueActionsBar.tsx`

- [ ] **Step 1: Add key={chatId} to TaskFromChatForm**

In `frontend/src/components/queue/QueueActionsBar.tsx`, change:

```tsx
<TaskFromChatForm
  open={taskOpen}
  chatId={chatId}
  chatTitle={chatTitle}
  onClose={() => setTaskOpen(false)}
  onCreated={onTaskCreated}
/>
```

to:

```tsx
<TaskFromChatForm
  key={chatId}
  open={taskOpen}
  chatId={chatId}
  chatTitle={chatTitle}
  onClose={() => setTaskOpen(false)}
  onCreated={onTaskCreated}
/>
```

- [ ] **Step 2: Remove "1/N" header element**

In `frontend/src/pages/QueuePage.tsx`, find the block:

```tsx
<div className="text-sm text-muted-foreground tabular-nums shrink-0 w-[4.5rem] text-right">
  {visibleQueueIds.length > 0 ? `${currentIndex + 1} / ${visibleQueueIds.length}` : '—'}
</div>
```

Delete it. Keep the rest of the header.

- [ ] **Step 3: Render last message with author + topic**

Find the block:

```tsx
{/* Current Message */}
<div className="bg-muted p-4 rounded-lg">
  <p className="text-sm">{currentDialog.lastMessage}</p>
  <p className="text-xs text-muted-foreground mt-2">{currentDialog.time}</p>
</div>
```

Replace with:

```tsx
{(() => {
  const lastMsg = state.messages[currentChatId]?.at(-1);
  const queueMeta = state.queueMeta?.[currentChatId];
  const topicTitle = queueMeta?.topic_title ?? null;
  return (
    <div className="bg-muted p-4 rounded-lg space-y-1">
      {topicTitle && (
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          # {topicTitle}
        </p>
      )}
      {isGroupChat && lastMsg?.senderName && (
        <p className="text-xs font-semibold text-blue-500">{lastMsg.senderName}</p>
      )}
      <p className="text-sm whitespace-pre-wrap break-words">{lastMsg?.text || currentDialog.lastMessage}</p>
      <p className="text-xs text-muted-foreground">{lastMsg?.time ?? currentDialog.time}</p>
    </div>
  );
})()}
```

> Note: `state.queueMeta` does not yet exist in the reducer — populate it from `/queue?meta=true` response. See next step.

- [ ] **Step 4: Wire `state.queueMeta` from /queue?meta=true**

In `TelegramContext.tsx`, add to the State type:

```typescript
queueMeta?: Record<number, { topic_id: number | null; topic_title: string | null }>;
```

Add a reducer action `SET_QUEUE_META`:

```typescript
case "SET_QUEUE_META":
  return { ...state, queueMeta: action.payload };
```

In `QueuePage.tsx`, replace `fetchQueue` with a meta-aware version:

```tsx
const fetchQueue = async () => {
  try {
    const res = await telegramApi.fetchJson(`/queue?meta=true${telegramApi.activeAccount ? `&account=${encodeURIComponent(telegramApi.activeAccount)}` : ""}`);
    const items: any[] = Array.isArray(res.queue) ? res.queue : [];
    const ids = items.map(i => i.chat_id);
    setQueueIds(prev => {
      const set = new Set(prev);
      const added: number[] = [];
      for (const id of ids) if (!set.has(id)) added.push(id);
      const filtered = prev.filter(id => ids.includes(id));
      return [...filtered, ...added];
    });
    const metaMap: Record<number, { topic_id: number | null; topic_title: string | null }> = {};
    for (const it of items) {
      metaMap[it.chat_id] = { topic_id: it.topic_id ?? null, topic_title: it.topic_title ?? null };
    }
    dispatch({ type: "SET_QUEUE_META", payload: metaMap });
  } catch {}
};
```

> `telegramApi.fetchJson` is currently private. Make it public or expose a typed wrapper `getQueueMeta()` instead. Recommended: add `async getQueueMeta(): Promise<{ chat_id, topic_id, topic_title }[]>` to telegramApi.

Add to telegramApi:

```typescript
async getQueueMeta(): Promise<Array<{ chat_id: number; topic_id: number | null; topic_title: string | null; folder_ids: number[]; last_message: any | null }>> {
  const res = await this.fetchJson('/queue?meta=true');
  return Array.isArray(res.queue) ? res.queue : [];
}
```

And use it in QueuePage:

```tsx
const items = await telegramApi.getQueueMeta();
```

- [ ] **Step 5: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 6: Commit**

```
git add frontend/src/pages/QueuePage.tsx frontend/src/components/queue/QueueActionsBar.tsx frontend/src/contexts/TelegramContext.tsx frontend/src/services/telegramApi.ts
git commit -m "feat(queue): drop 1/N counter; key={chatId} for TaskFromChatForm; show author + topic on card"
```

---

## Task 17: Final smoke + run all tests

**Files:** none

- [ ] **Step 1: Run full backend suite**

```
cd backend && python -m pytest -q
```

Expected: all green.

- [ ] **Step 2: Frontend lint + build**

```
cd frontend && npm run lint && npm run build
```

Expected: lint passes, dist built.

- [ ] **Step 3: Manual sanity walk (skip if unable to attach to live Telegram)**

Per Spec A test plan:
1. Header has no `1/N`.
2. QueueFilter chips work.
3. Sending in /chat/:id removes that chat from queue (~1 s).
4. TaskFromChatForm shows the **current** chat title after navigating between chats.
5. Forum-supergroup → TopicsPage → click topic → ChatPage scoped to topic.
6. Group queue card shows author name above message.

- [ ] **Step 4: Final commit (if any leftovers)**

```
git status
git add -A
git diff --cached --stat
```

If clean, no commit needed.

---

## Self-review

- **Spec coverage:**
  - п.1 (TaskFromChatForm name) → Task 16 (`key={chatId}`) ✓
  - п.3 (chat exits queue after reply) → Task 1 (outgoing handler) ✓
  - п.5 (forum topics) → Tasks 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14 ✓
  - п.6 (filters / no archive / no 1/N / author on card) → Tasks 15, 16 ✓
- **Type consistency:**
  - `make_router(queue)` arg order: positional in old code, kwargs throughout new code. Task 6 explicitly switches to kwargs and updates `main.py`.
  - `make_incoming_handler` adds optional kwargs `topics_service`, `queue_meta_cache`. Task 7 updates `main.py` to pass them.
  - `getMessages(chatId, limit, topicId)` order matches `getOlderMessages(chatId, beforeId, limit, topicId)` — limit position is consistent within each.
- **Placeholders:** none. Every step has full code or exact commands.

---

## Execution

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
