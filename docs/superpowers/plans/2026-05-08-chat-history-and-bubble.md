# Chat History & Bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec C — fix Saved Messages bug, add infinite-scroll-up history loading with cache extension, replace fixed bubble width with adaptive Telegram-style sizing and link wrapping.

**Architecture:** Backend `/dialogs` is augmented to inject Saved Messages when Pyrogram omits it; `/messages` skips the empty-content filter for self-chat. Frontend extracts `MessageBubble` with adaptive width and `Linkify`, adds `useInfiniteScrollUp` hook with anchored scroll preservation, and grows IndexedDB cache to 1000 messages with a `prependCached` function.

**Tech Stack:** Pyrogram, FastAPI, React + TypeScript, IntersectionObserver, idb-keyval, Tailwind utility classes.

**Spec:** [docs/superpowers/specs/2026-05-08-chat-history-and-bubble-design.md](../specs/2026-05-08-chat-history-and-bubble-design.md)

**Depends on:** Spec A (`topic_id`), Spec B (`MediaRenderer`).

---

## File map

**Backend — modify:**
- `backend/routers/dialogs.py` — add Saved Messages fallback in `_build_dialogs_and_queue`
- `backend/routers/messages.py` — for self-chat (chat_id == me.id), don't drop empty-text/empty-media messages
- `backend/tests/test_dialogs_saved.py` (new)
- `backend/tests/test_messages_saved.py` (new)

**Frontend — create:**
- `frontend/src/components/chat/MessageBubble.tsx`
- `frontend/src/components/chat/Linkify.tsx`
- `frontend/src/components/chat/useInfiniteScrollUp.ts`

**Frontend — modify:**
- `frontend/src/services/messageCache.ts` — `MAX_MSGS_PER_CHAT` 100 → 1000; add `prependCached`
- `frontend/src/contexts/TelegramContext.tsx` — `PREPEND_MESSAGES` reducer action
- `frontend/src/pages/ChatPage.tsx` — use `MessageBubble`, `useInfiniteScrollUp`; remove `state.isInitialized` block; better Saved Messages handling
- `frontend/src/pages/HomePage.tsx` — guarantee Saved Messages row visible (uses backend-provided dialog if present)
- `frontend/src/pages/MessagePage.tsx` — same

---

## Task 1: Saved Messages fallback in /dialogs

**Files:**
- Modify: `backend/routers/dialogs.py`
- Create: `backend/tests/test_dialogs_saved.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_dialogs_saved.py`:

```python
"""Tests for Saved Messages fallback in /dialogs build."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from routers.dialogs import _build_dialogs_and_queue


def _dialog(chat_id, *, ctype="private", title="X", unread=0, folder_id=0):
    return SimpleNamespace(
        chat=SimpleNamespace(
            id=chat_id, type=SimpleNamespace(value=ctype),
            title=title, first_name=None, last_name=None,
            username=None, is_forum=False,
        ),
        top_message=None,
        unread_messages_count=unread,
        folder_id=folder_id,
    )


class _FakeClient:
    def __init__(self, dialogs, me_id, saved_chat=None):
        self._dialogs = dialogs
        self._me = SimpleNamespace(id=me_id)
        self._saved = saved_chat or SimpleNamespace(
            id=me_id, type=SimpleNamespace(value="private"),
            title="Saved Messages", first_name=None, last_name=None,
            username=None, is_forum=False,
        )

    async def get_dialogs(self, limit=100):
        for d in self._dialogs:
            yield d

    async def get_me(self):
        return self._me

    async def get_chat(self, chat_id):
        if chat_id == self._me.id:
            return self._saved
        raise RuntimeError("not found")


async def test_dialogs_includes_saved_messages_when_pyrogram_omits_it():
    me_id = 555
    dialogs = [_dialog(100, title="Friend"), _dialog(200, title="Group", ctype="group")]
    client = _FakeClient(dialogs=dialogs, me_id=me_id)

    out = await _build_dialogs_and_queue(client, limit=100)

    titles = [d["title"] for d in out["dialogs"]]
    assert "Saved Messages" in titles
    saved = next(d for d in out["dialogs"] if d["chat_id"] == me_id)
    assert saved["type"] == "private"
    assert saved["is_saved_messages"] is True


async def test_dialogs_does_not_duplicate_saved_messages():
    me_id = 555
    dialogs = [
        _dialog(me_id, title="Saved Messages"),
        _dialog(100, title="Friend"),
    ]
    client = _FakeClient(dialogs=dialogs, me_id=me_id)

    out = await _build_dialogs_and_queue(client, limit=100)

    saved_count = sum(1 for d in out["dialogs"] if d["chat_id"] == me_id)
    assert saved_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_dialogs_saved.py -v
```

Expected: failures (no fallback yet).

- [ ] **Step 3: Update _build_dialogs_and_queue**

In `backend/routers/dialogs.py`, replace the function:

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

    # Saved Messages fallback: ensure self-chat is always discoverable.
    try:
        me = await client.get_me()
        me_id = int(getattr(me, "id", 0) or 0)
    except Exception:
        logger.debug("get_me() failed in dialogs build", exc_info=True)
        me_id = 0
    if me_id and not any(d["chat_id"] == me_id for d in dialogs):
        try:
            saved = await client.get_chat(me_id)
            dialogs.append({
                "chat_id": me_id,
                "title": getattr(saved, "title", None) or "Saved Messages",
                "type": "private",
                "username": getattr(saved, "username", None),
                "unread_count": 0,
                "last_message_text": None,
                "folder_id": 0,
                "is_forum": False,
                "is_saved_messages": True,
            })
        except Exception:
            logger.debug("Saved Messages fallback fetch failed", exc_info=True)
    else:
        # Mark the existing self-chat row.
        for d in dialogs:
            if d["chat_id"] == me_id:
                d["is_saved_messages"] = True
                if not d.get("title"):
                    d["title"] = "Saved Messages"

    queue_ids = _build_queue_from_dialogs(dialogs_raw)
    return {"dialogs": dialogs, "queue": queue_ids, "archived_ids": archived_ids}
```

- [ ] **Step 4: Run tests**

```
cd backend && python -m pytest tests/test_dialogs_saved.py tests/test_dialogs_logic.py -v
```

Expected: pass.

- [ ] **Step 5: Commit**

```
git add backend/routers/dialogs.py backend/tests/test_dialogs_saved.py
git commit -m "fix(dialogs): inject Saved Messages when Pyrogram omits it"
```

---

## Task 2: /messages — keep all messages for self-chat

**Files:**
- Modify: `backend/routers/messages.py`
- Create: `backend/tests/test_messages_saved.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_messages_saved.py`:

```python
"""Tests that /messages does not drop content-empty messages for the self-chat."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.messages import make_router


class _Auth:
    def __init__(self, client): self._client = client
    async def get_authorized_client(self, account): return self._client


class _Manager:
    def __init__(self, client):
        self._client = client; self.default = client
    def get_or_create(self, account): return self._client
    async def ensure_connected(self, c): return None


def _msg(mid, text=None, outgoing=False):
    return SimpleNamespace(
        id=mid, text=text, caption=None,
        date=datetime(2026, 5, 8),
        from_user=SimpleNamespace(id=555, first_name="Me", last_name=None),
        sender_chat=None, outgoing=outgoing,
        photo=None, video=None, voice=None, video_note=None, document=None, audio=None,
        chat=SimpleNamespace(id=555),
    )


def test_messages_for_self_chat_keeps_empty_messages():
    me_id = 555
    history = [_msg(1, text=None, outgoing=True), _msg(2, text="hi", outgoing=True)]

    async def fake_history(chat_id, **kw):
        for m in history:
            yield m

    client = MagicMock()
    client.me = SimpleNamespace(id=me_id)
    async def get_me(): return client.me
    client.get_me = get_me
    client.get_chat_history = fake_history

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.get(f"/messages?chat_id={me_id}")
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()["messages"]]
    assert 1 in ids and 2 in ids


def test_messages_for_other_chat_still_filters_empty():
    history = [_msg(1, text=None), _msg(2, text="hi")]

    async def fake_history(chat_id, **kw):
        for m in history:
            yield m

    client = MagicMock()
    client.me = SimpleNamespace(id=555)
    async def get_me(): return client.me
    client.get_me = get_me
    client.get_chat_history = fake_history

    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    api = TestClient(app)

    r = api.get("/messages?chat_id=100")
    ids = [m["id"] for m in r.json()["messages"]]
    assert ids == [2]
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_messages_saved.py -v
```

Expected: first test fails (id 1 missing).

- [ ] **Step 3: Update get_messages**

In `backend/routers/messages.py`, modify `get_messages`:

```python
@router.get("/messages")
async def get_messages(
    chat_id: int,
    limit: int = 50,
    before_id: Optional[int] = None,
    topic_id: Optional[int] = None,
    account: str = "",
):
    client = await auth.get_authorized_client(account)
    me_id: Optional[int] = None
    try:
        me = getattr(client, "me", None) or await client.get_me()
        me_id = int(getattr(me, "id", 0) or 0)
    except Exception:
        logger.debug("get_me failed in /messages", exc_info=True)
    is_self_chat = me_id is not None and int(chat_id) == me_id

    history: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"limit": limit}
    if before_id:
        try:
            kwargs["max_id"] = int(before_id) - 1
        except Exception:
            logger.debug("invalid before_id %r", before_id, exc_info=True)
    if topic_id is not None:
        kwargs["message_thread_id"] = int(topic_id)
    async for m in client.get_chat_history(chat_id, **kwargs):
        text_content = (m.text or m.caption or "").strip()
        media_info = extract_media_info(m, chat_id=chat_id)
        if not text_content and not media_info and not is_self_chat:
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
```

- [ ] **Step 4: Run tests**

```
cd backend && python -m pytest tests/test_messages_saved.py tests/test_messages_since.py -v
```

Expected: both pass.

- [ ] **Step 5: Commit**

```
git add backend/routers/messages.py backend/tests/test_messages_saved.py
git commit -m "fix(messages): keep content-empty messages for self-chat (Saved Messages)"
```

---

## Task 3: messageCache — MAX 1000 + prependCached

**Files:**
- Modify: `frontend/src/services/messageCache.ts`

- [ ] **Step 1: Bump max and add prependCached**

Replace the file:

```typescript
import { createStore, get, set, del, keys, entries } from "idb-keyval";
import type { Message } from "@/types/telegram";

const STORE = createStore("tg-focus-msg-cache", "chats");

const MAX_CHATS = 50;
const MAX_MSGS_PER_CHAT = 1000;
const TOUCH_THROTTLE_MS = 10_000;

type Entry = {
  messages: Message[];
  lastSyncAt: number;
  lastTouchedAt: number;
};

const keyFor = (chatId: number) => `chat:${chatId}`;

const writeQueues = new Map<number, Promise<void>>();

function withChatLock(chatId: number, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => undefined).finally(() => {
    if (writeQueues.get(chatId) === next) writeQueues.delete(chatId);
  });
  writeQueues.set(chatId, next);
  return next;
}

export async function getCached(chatId: number): Promise<Entry | null> {
  try {
    const e = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
    if (!e) return null;
    if (Date.now() - (e.lastTouchedAt ?? 0) > TOUCH_THROTTLE_MS) {
      void withChatLock(chatId, async () => {
        await set(keyFor(chatId), { ...e, lastTouchedAt: Date.now() }, STORE);
      });
    }
    return e;
  } catch {
    return null;
  }
}

export async function setCached(chatId: number, messages: Message[]): Promise<void> {
  return withChatLock(chatId, async () => {
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
  });
}

export async function appendCached(
  chatId: number,
  newMessages: Message[],
): Promise<void> {
  if (newMessages.length === 0) return;
  return withChatLock(chatId, async () => {
    try {
      const existing = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
      if (existing === null) return;
      const seen = new Set(existing.messages.map((m) => m.id));
      const merged = [
        ...existing.messages,
        ...newMessages.filter((m) => !seen.has(m.id)),
      ];
      merged.sort((a, b) => a.id - b.id);
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
  });
}

/**
 * Prepend older messages (deduped). Trims to MAX_MSGS_PER_CHAT keeping NEWEST.
 * No-op when there's no existing entry.
 */
export async function prependCached(
  chatId: number,
  olderMessages: Message[],
): Promise<void> {
  if (olderMessages.length === 0) return;
  return withChatLock(chatId, async () => {
    try {
      const existing = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
      if (existing === null) return;
      const seen = new Set(existing.messages.map((m) => m.id));
      const merged = [
        ...olderMessages.filter((m) => !seen.has(m.id)),
        ...existing.messages,
      ];
      merged.sort((a, b) => a.id - b.id);
      const trimmed = merged.slice(-MAX_MSGS_PER_CHAT);
      await set(
        keyFor(chatId),
        { messages: trimmed, lastSyncAt: Date.now(), lastTouchedAt: Date.now() },
        STORE,
      );
    } catch {
      /* best-effort */
    }
  });
}

export async function clearCached(chatId: number): Promise<void> {
  return withChatLock(chatId, async () => {
    try { await del(keyFor(chatId), STORE); } catch {}
  });
}

async function enforceCapacity(): Promise<void> {
  const all = await entries<string, Entry>(STORE);
  if (all.length <= MAX_CHATS) return;
  all.sort((a, b) => (a[1].lastTouchedAt ?? 0) - (b[1].lastTouchedAt ?? 0));
  const toDrop = all.slice(0, all.length - MAX_CHATS);
  await Promise.all(toDrop.map(([k]) => del(k, STORE)));
}

export async function listCachedChats(): Promise<number[]> {
  const ks = await keys<string>(STORE);
  return ks
    .filter((k) => k.startsWith("chat:"))
    .map((k) => Number(k.slice("chat:".length)))
    .filter((n) => Number.isFinite(n));
}
```

- [ ] **Step 2: Type-check**

```
cd frontend && npx tsc --noEmit
```

Expected: pass.

- [ ] **Step 3: Commit**

```
git add frontend/src/services/messageCache.ts
git commit -m "feat(cache): MAX_MSGS_PER_CHAT 1000; add prependCached"
```

---

## Task 4: PREPEND_MESSAGES reducer

**Files:**
- Modify: `frontend/src/contexts/TelegramContext.tsx`

- [ ] **Step 1: Locate the reducer**

```
cd frontend && grep -n "case \"SET_MESSAGES\"\|reducer\|switch (action.type)" src/contexts/TelegramContext.tsx | head
```

- [ ] **Step 2: Add the action type and case**

In the `Action` union (or wherever message-related action types live):

```typescript
| { type: "PREPEND_MESSAGES"; payload: { chatId: number; messages: Message[] } }
```

In the reducer switch (next to `SET_MESSAGES`):

```typescript
case "PREPEND_MESSAGES": {
  const existing = state.messages[action.payload.chatId] ?? [];
  const seen = new Set(existing.map((m) => m.id));
  const fresh = action.payload.messages.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return state;
  return {
    ...state,
    messages: {
      ...state.messages,
      [action.payload.chatId]: [...fresh, ...existing].sort((a, b) => a.id - b.id),
    },
  };
}
```

- [ ] **Step 3: Type-check**

```
cd frontend && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```
git add frontend/src/contexts/TelegramContext.tsx
git commit -m "feat(state): PREPEND_MESSAGES reducer for older history pages"
```

---

## Task 5: useInfiniteScrollUp hook

**Files:**
- Create: `frontend/src/components/chat/useInfiniteScrollUp.ts`

- [ ] **Step 1: Create the hook**

```typescript
// frontend/src/components/chat/useInfiniteScrollUp.ts
import { RefObject, useEffect, useRef } from "react";

type Opts = {
  containerRef: RefObject<HTMLDivElement>;
  onLoadMore: () => Promise<{ added: number }>;
  enabled: boolean;
  rootMargin?: string;
};

export function useInfiniteScrollUp(opts: Opts) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const reachedTopRef = useRef(false);

  useEffect(() => {
    reachedTopRef.current = false;
  }, [opts.containerRef]);

  useEffect(() => {
    if (!opts.enabled || reachedTopRef.current) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    const container = opts.containerRef.current;
    if (!sentinel || !container) return;

    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting || loadingRef.current) return;
        loadingRef.current = true;
        const prevScrollHeight = container.scrollHeight;
        const prevScrollTop = container.scrollTop;
        try {
          const { added } = await opts.onLoadMore();
          if (added === 0) {
            reachedTopRef.current = true;
            io.disconnect();
          } else {
            requestAnimationFrame(() => {
              container.scrollTop =
                prevScrollTop + (container.scrollHeight - prevScrollHeight);
            });
          }
        } catch {
          // swallow — next intersection will retry
        } finally {
          loadingRef.current = false;
        }
      },
      { root: container, rootMargin: opts.rootMargin ?? "200px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [opts.enabled, opts.onLoadMore, opts.containerRef, opts.rootMargin]);

  return { sentinelRef };
}
```

- [ ] **Step 2: Type-check**

```
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add frontend/src/components/chat/useInfiniteScrollUp.ts
git commit -m "feat(chat): useInfiniteScrollUp hook with anchored scroll preservation"
```

---

## Task 6: Linkify utility

**Files:**
- Create: `frontend/src/components/chat/Linkify.tsx`

- [ ] **Step 1: Create Linkify**

```tsx
// frontend/src/components/chat/Linkify.tsx
import React from "react";

const URL_RE = /(https?:\/\/[^\s]+)/g;

export function Linkify({ children }: { children: string }) {
  if (!children) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of children.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(children.slice(last, start));
    parts.push(
      <a
        key={`u-${i++}`}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all text-blue-500 hover:text-blue-400"
      >
        {match[0]}
      </a>
    );
    last = start + match[0].length;
  }
  if (last < children.length) parts.push(children.slice(last));
  return <>{parts}</>;
}
```

- [ ] **Step 2: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```
git add frontend/src/components/chat/Linkify.tsx
git commit -m "feat(chat): Linkify utility for clickable URLs in message text"
```

---

## Task 7: MessageBubble component (adaptive width)

**Files:**
- Create: `frontend/src/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Create MessageBubble**

```tsx
// frontend/src/components/chat/MessageBubble.tsx
import React from "react";
import type { MediaType } from "@/types/telegram";
import { MediaRenderer } from "@/components/media/MediaRenderer";
import type { LightboxItem } from "@/components/media/Lightbox";
import { Linkify } from "./Linkify";

export type BubbleMessage = {
  id: number;
  text: string;
  isOutgoing: boolean;
  time: string;
  senderName?: string;
  mediaType?: MediaType;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
};

type Props = {
  message: BubbleMessage;
  showSenderName?: boolean;
  onLightbox?: (item: LightboxItem) => void;
};

export function MessageBubble({ message, showSenderName, onLightbox }: Props) {
  const wrapperJustify = message.isOutgoing ? "justify-end" : "justify-start";
  const bubbleColor = message.isOutgoing
    ? "bg-primary text-primary-foreground"
    : "bg-muted";
  const timeColor = message.isOutgoing
    ? "text-primary-foreground/70"
    : "text-muted-foreground";

  return (
    <div className={`flex ${wrapperJustify}`}>
      <div
        className={[
          "px-4 py-2 rounded-2xl",
          "max-w-[85%] sm:max-w-[70%] md:max-w-[60%]",
          "break-words [overflow-wrap:anywhere]",
          bubbleColor,
        ].join(" ")}
      >
        {showSenderName && message.senderName && (
          <p className="text-xs font-semibold text-blue-500 mb-0.5">{message.senderName}</p>
        )}
        {message.mediaType && message.mediaUrl && (
          <MediaRenderer
            mediaType={message.mediaType}
            mediaUrl={message.mediaUrl}
            fileName={message.fileName}
            fileSize={message.fileSize}
            mimeType={message.mimeType}
            duration={message.duration}
            onLightbox={onLightbox}
          />
        )}
        {message.text && (
          <p className="text-sm whitespace-pre-wrap">
            <Linkify>{message.text}</Linkify>
          </p>
        )}
        <p className={`text-[11px] mt-1 ${timeColor}`}>{message.time}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```
git add frontend/src/components/chat/MessageBubble.tsx
git commit -m "feat(chat): MessageBubble with adaptive width + Linkify"
```

---

## Task 8: ChatPage uses MessageBubble + useInfiniteScrollUp + better Saved Messages handling

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`

- [ ] **Step 1: Imports**

Add at the top:

```tsx
import { MessageBubble } from "@/components/chat/MessageBubble";
import { useInfiniteScrollUp } from "@/components/chat/useInfiniteScrollUp";
import { prependCached } from "@/services/messageCache";
```

(Keep imports of MediaRenderer/Lightbox/AttachMenu from Plan B Task 10.)

- [ ] **Step 2: Replace messages.map render with MessageBubble**

Find the `messages.map((msg) => ...)` block. Replace with:

```tsx
{messages.map((msg) => (
  <MessageBubble
    key={msg.id}
    message={msg}
    showSenderName={isGroup && !msg.isOutgoing}
    onLightbox={(item) => setLightboxItem(item)}
  />
))}
```

`messages` already has shape `{id, text, isOutgoing, time, senderName, mediaType, mediaUrl, duration, ...}`. If `fileSize`/`mimeType` aren't yet in the local `UiMsg` type from earlier work, extend the useMemo block to copy them through:

```tsx
const messages = useMemo<BubbleMessage[]>(() => {
  const list = state.messages[numericChatId] || [];
  const filtered = topicId === undefined ? list : list.filter((m) => m.topicId === topicId);
  return filtered.map((m) => ({
    id: m.id,
    text: m.text,
    isOutgoing: m.isOutgoing,
    time: new Date(m.date).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
    senderName: m.senderName,
    mediaType: m.mediaType,
    mediaUrl: m.mediaUrl,
    fileName: m.fileName,
    fileSize: (m as any).fileSize,
    mimeType: (m as any).mimeType,
    duration: m.duration,
  }));
}, [state.messages, numericChatId, topicId]);
```

(`BubbleMessage` is exported from `MessageBubble.tsx`.)

- [ ] **Step 3: Replace scroll-handler with useInfiniteScrollUp**

Delete the existing `useEffect` that adds a `scroll` listener checking `el.scrollTop < 50`. Replace with:

```tsx
const onLoadOlder = useCallback(async () => {
  const list = state.messages[numericChatId];
  const firstId = list && list.length > 0 ? list[0].id : undefined;
  if (!firstId) return { added: 0 };
  const older = await telegramApi.getOlderMessages(numericChatId, firstId, 100, topicId);
  if (older.length === 0) return { added: 0 };
  dispatch({
    type: "PREPEND_MESSAGES",
    payload: { chatId: numericChatId, messages: older },
  });
  await prependCached(numericChatId, older);
  return { added: older.length };
}, [numericChatId, state.messages, topicId, dispatch]);

const { sentinelRef } = useInfiniteScrollUp({
  containerRef: listRef,
  onLoadMore: onLoadOlder,
  enabled: !!numericChatId && messages.length > 0,
});
```

In the JSX, render the sentinel as the first child of the scroll container:

```tsx
<div ref={listRef} className="flex-1 overflow-y-auto p-4 pb-24 space-y-3">
  <div ref={sentinelRef} />
  {messages.map((msg) => (
    <MessageBubble key={msg.id} message={msg} showSenderName={isGroup && !msg.isOutgoing} onLightbox={(it) => setLightboxItem(it)} />
  ))}
  <div ref={bottomRef} />
</div>
```

- [ ] **Step 4: Soften the isInitialized gate**

Find:

```tsx
if (!state.isInitialized) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <p className="text-muted-foreground">Восстановление сессии...</p>
    </div>
  );
}
```

Replace with:

```tsx
// Render even before context is fully initialized — cache and the per-chat
// fetch effect populate state.messages independently.
```

(remove the early return entirely). Keep `state.isInitialized` reference in the existing `useEffect` only as a noop guard — change it to `if (!numericChatId) return;` and drop the `state.isInitialized` dep.

- [ ] **Step 5: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 6: Commit**

```
git add frontend/src/pages/ChatPage.tsx
git commit -m "feat(chat): infinite scroll up + MessageBubble; remove isInitialized gate"
```

---

## Task 9: HomePage and MessagePage — show Saved Messages

**Files:**
- Modify: `frontend/src/pages/HomePage.tsx`
- Modify: `frontend/src/pages/MessagePage.tsx`

- [ ] **Step 1: Locate chat-list rendering in both files**

```
cd frontend && grep -n "state.chats\|chats.map\|dialogs.map" src/pages/HomePage.tsx src/pages/MessagePage.tsx
```

Confirm both pages list dialogs from `state.chats` (or similar source).

- [ ] **Step 2: Verify Saved Messages comes through**

Backend now always includes `is_saved_messages: true` for the self-chat (Task 1). In the chat-list row, decide on title and icon:

```tsx
const displayTitle = chat.id === currentUser?.id ? "Избранное" : chat.title;
```

Add this in HomePage and MessagePage chat-list rendering. If a `currentUser` is already in scope (via context), use `state.user?.id`. Otherwise, expose `currentUser` through `useTelegram()`.

If the page sorts dialogs by recency and Saved Messages has no last message, it may end up at the bottom — that's fine, but ensure it's not filtered out. Check filters (e.g., type/folder) and make sure `is_saved_messages` always passes.

- [ ] **Step 3: Add a star icon to the Saved Messages row**

Inline import:

```tsx
import { Bookmark } from "lucide-react";
```

In the avatar/icon block:

```tsx
{chat.id === state.user?.id ? (
  <div className="h-8 w-8 rounded-full bg-blue-500 flex items-center justify-center">
    <Bookmark className="h-4 w-4 text-white" />
  </div>
) : (
  <Avatar className="h-8 w-8">
    <AvatarFallback>{chat.title[0]}</AvatarFallback>
  </Avatar>
)}
```

- [ ] **Step 4: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 5: Commit**

```
git add frontend/src/pages/HomePage.tsx frontend/src/pages/MessagePage.tsx
git commit -m "feat(chats): always show Saved Messages with bookmark icon"
```

---

## Task 10: Final validation

**Files:** none

- [ ] **Step 1: Backend tests**

```
cd backend && python -m pytest -q
```

Expected: all green.

- [ ] **Step 2: Frontend lint + build**

```
cd frontend && npm run lint && npm run build
```

- [ ] **Step 3: Manual sanity walk**

Per Spec C test plan:
1. Open «Избранное» → ChatPage loads, history visible (was empty before).
2. Send messages to Saved Messages from official Telegram → they appear in our app within ~1 s.
3. Paste a 200-char URL into a message — bubble doesn't overflow; URL wraps; click opens in new tab.
4. In any chat with >100 messages: scroll up — older messages stream in; scroll position stays anchored; eventually the very first message is reached and no spinner remains.
5. Reload page → cached messages render instantly; delta-sync appends the rest; scroll up still works.
6. Send «ok» → bubble shrinks; long paragraph → wraps inside 60–85% of width.
7. In a topic-scoped chat (Spec A): scroll up only loads that topic's older history.

- [ ] **Step 4: Final commit if anything dangling**

```
git status
```

---

## Self-review

- **Spec coverage:**
  - п.4 (Saved Messages) → Tasks 1, 2 (backend) + Task 8 step 4 (frontend gate) + Task 9 (display) ✓
  - п.9 (full history / infinite scroll) → Tasks 3, 4, 5, 8 ✓
  - п.10 (adaptive bubble) → Tasks 6, 7, 8 ✓
- **Type consistency:**
  - `BubbleMessage` exported from `MessageBubble.tsx` and consumed in `ChatPage.useMemo` ✓
  - `prependCached(chatId, messages)` matches reducer payload `messages` field ✓
  - `useInfiniteScrollUp` returns `{ sentinelRef }` matching its consumer ✓
- **Placeholders:** none.

---

## Execution

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
