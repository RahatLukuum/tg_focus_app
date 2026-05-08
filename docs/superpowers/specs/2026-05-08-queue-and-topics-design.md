# Spec A — Queue & Topics

**Date:** 2026-05-08
**Branch:** `denis-branch`
**Status:** draft (pending user review)

## Goal

Починить логику разбора очереди (фильтры, отображение, ошибки UX) и добавить поддержку forum-supergroups (групп с темами) сквозным образом — от backend до экрана разбора.

Покрывает пункты пользователя:
- **#1** — некорректное имя в форме «Ответить ...» при создании задачи из очереди.
- **#3** — чат не уходит из очереди после того, как пользователь отвечает прямо в чате (открыл `/chat/:id`).
- **#5** — поддержка forum-supergroups (Telegram «темы»): отдельный экран со списком тем, навигация в тему, сохранение `message_thread_id` для отправки сообщений.
- **#6** — фильтры в разборе очереди: чипы Личные/Группы; уход чатов из архива; убрать счётчик `1/...` справа сверху; в групповом сообщении на карточке очереди показывать имя автора.

## Non-goals

- Медиа на карточке очереди и в сообщениях — это **Spec B**.
- Бесконечный скролл истории, баг Saved Messages, рамка сообщения — это **Spec C**.
- Многоаккаунтная обработка топиков — топики кешируются per-account (как папки), но UI остаётся для активного аккаунта.

## Architecture

```
Backend (FastAPI + Pyrogram)
  services/topics_service.py     [NEW]   — wrapper над client.get_forum_topics + TTL cache
  services/queue_service.py      [EDIT]  — без изменений структур; добавляем topic_id в meta только в payload
  routers/topics.py              [NEW]   — GET /topics?chat_id=...  → [{topic_id, title, icon_color, icon_emoji}]
  routers/queue.py               [EDIT]  — meta=true возвращает last_message {text, from_name, media_*}, topic_title; убрать пустой "1/..."-семантический хак (это фронтенд)
  routers/messages.py            [EDIT]  — get_messages принимает topic_id (опц.); send_message принимает message_thread_id
  routers/dialogs.py             [EDIT]  — _map_dialog добавляет is_forum=bool
  handlers/incoming.py           [EDIT]  — добавить outgoing-handler: при m.outgoing && chat_id ∈ queue → queue_service.remove + broadcast
  handlers/incoming.py           [EDIT]  — на incoming в forum-чате прокидывать topic_id, topic_title в payload и в queue_update

Frontend (React + Vite + TS)
  pages/TopicsPage.tsx           [NEW]   — экран /chat/:id/topics для forum-supergroups
  pages/QueuePage.tsx            [EDIT]  — убрать "1/N" из header; lastMessage теперь полноценный объект с автором; QueueFilter (Личные/Группы + папки)
  pages/ChatPage.tsx             [EDIT]  — поддержка ?topic_id=N; передавать в getMessages/sendMessage
  pages/MessagePage.tsx          [EDIT]  — клик по forum-supergroup ведёт на /chat/:id/topics, не сразу в /chat/:id
  components/queue/QueueFilter.tsx [NEW] — расширение QueueFolderFilter: типы + папки в одном компоненте
  components/queue/QueueFolderFilter.tsx [DELETE] — заменён QueueFilter
  components/queue/TaskFromChatForm.tsx [EDIT] — фикс stale chatTitle через key={chatId} в parent
  components/queue/QueueActionsBar.tsx [EDIT] — добавить key={chatId} для TaskFromChatForm
  services/telegramApi.ts        [EDIT]  — getMessages(chatId, limit, before_id, topic_id); sendMessage(..., topic_id); getTopics(chatId); queueAction "done" триггерит локальное удаление (уже есть)
  services/foldersApi.ts         [EDIT]  — добавить getTopics
  types/telegram.ts              [EDIT]  — Topic type; Chat.isForum?: boolean; Message.topicId?: number
```

## Data flow

### Outgoing-driven queue removal (#3)

```
User opens /chat/:id  →  sends message via UI or directly in Telegram client
                       │
                       ▼
        Pyrogram on_message handler (NEW: filters m.outgoing == True)
                       │
                       ▼
        if chat_id ∈ queue[account]:
            queue_service.remove(account, chat_id)
            broadcaster.broadcast({type: "queue_update", removed: chat_id})
                       │
                       ▼
        Frontend WS listener (already present) → fetchQueue() → setQueueIds
```

**Key invariant:** ровно один источник правды — backend handler. Не пытаемся локально убирать чат на frontend сразу после `sendMessage` — пусть WS придёт. Если WS не дошёл (offline), при следующем фокусе вкладки `fetchQueue` подхватит актуальное состояние.

### Topics navigation (#5)

```
GET /dialogs                                      MessagePage
  → returns dialogs with is_forum=true            ↓
                                                 click on forum chat
                                                 → navigate(`/chat/${id}/topics`)
                                                  ↓
GET /topics?chat_id=<forum_chat_id>             TopicsPage
  → [{topic_id, title, icon_color, icon_emoji,    ↓
     unread_count, last_message_text}]           click on topic
                                                 → navigate(`/chat/${id}?topic_id=${tid}`)
                                                  ↓
GET /messages?chat_id=<id>&topic_id=<tid>       ChatPage
POST /send_message {chat_id, text,                ↓
                     reply_to_message_id?,        Renders only messages with
                     message_thread_id=<tid>}    message_thread_id == tid
```

**Pyrogram API:** `client.get_forum_topics(chat_id)` is an async generator yielding `Topic` objects with attrs `id, title, icon_color, icon_emoji_id, unread_count, top_message`. For sending into a topic: `client.send_message(chat_id, text, message_thread_id=topic_id)`. For history within a topic: `client.get_chat_history(chat_id, message_thread_id=topic_id)` — Pyrogram supports this kwarg.

### Topic info on queue card (#6, secondary)

When `incoming.handler` fires in a forum-supergroup, Pyrogram's `Message` has `message.message_thread_id` (= topic id). Resolving the topic title requires a lookup against `topics_service.get_topics(account, chat_id)` (cached). Handler enriches the broadcast payload:

```python
{
    "type": "message",
    "chat_id": ...,
    "chat_title": ...,
    "topic_id": 12345,        # NEW
    "topic_title": "Bug reports",  # NEW (from cache, may be None on cold cache)
    "message": {...},
}
```

`/queue?meta=true` enriches each entry similarly.

## Component design (frontend)

### `QueueFilter.tsx` (replaces `QueueFolderFilter`)

```tsx
type FilterState = { types: ("private" | "groups")[]; folderIds: number[] };

export function QueueFilter({ onChange }: { onChange: (s: FilterState) => void }) {
  // persists to localStorage key "queue_filter"
  // renders two ChipFilter rows: TYPE_OPTIONS, then folder options from useFolders()
}
```

`QueuePage.visibleQueueIds` filters by both: type comes from `state.chats.find(c => c.id === cid)?.type`, folder from `chatToFolders.get(cid)`.

### `TopicsPage.tsx`

Mirror of MessagePage list-style: header «Назад» + chat title; vertical list of topic rows; each row shows icon emoji (if available, fallback to colored circle), title, unread badge, last message preview. Click → `navigate(\`/chat/${chatId}?topic_id=${topicId}\`)`.

### Bug #1 fix (TaskFromChatForm)

Root cause: `useState<string>(\`Ответить ${chatTitle}\`)` only runs the initializer **once per mount**. The form is conditionally rendered with `if (!open) return null;` but the parent's `<TaskFromChatForm />` element keeps the same React fiber, so `useState` doesn't reinitialize when `chatTitle` prop changes.

Fix: in `QueueActionsBar.tsx`, render with `key={chatId}` so React unmounts/remounts when the chat changes:

```tsx
<TaskFromChatForm
  key={chatId}
  open={taskOpen}
  chatId={chatId}
  chatTitle={chatTitle}
  ...
/>
```

This is preferable to a `useEffect` sync because the form has its own draft state that should also reset between chats.

### Header cleanup (#6)

Remove from `QueuePage.tsx:549-551`:
```tsx
<div className="text-sm text-muted-foreground tabular-nums shrink-0 w-[4.5rem] text-right">
  {visibleQueueIds.length > 0 ? `${currentIndex + 1} / ${visibleQueueIds.length}` : '—'}
</div>
```

Header keeps only «Разбор очереди» + «В очереди: N» badge below (already present).

### Author on group queue card (#6)

Currently `currentDialog.lastMessage` is plain text from `history.at(-1)?.text`. Replace with structured object:

```tsx
const lastMsg = state.messages[currentChatId]?.at(-1);
// In the «current message» bubble:
{isGroupChat && lastMsg?.senderName && (
  <p className="text-xs font-semibold text-blue-500 mb-0.5">{lastMsg.senderName}</p>
)}
{topicTitle && (
  <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
    # {topicTitle}
  </p>
)}
<p className="text-sm">{lastMsg?.text ?? ''}</p>
```

`topicTitle` lookup: from `state.queueMeta[currentChatId]?.topic_title`, populated by `/queue?meta=true`.

## API surface

### New: `GET /topics`

```
GET /topics?chat_id=-1001234567890&account=+7...
→ {
    "chat_id": -1001234567890,
    "topics": [
      {"topic_id": 1, "title": "General", "icon_color": 9367192, "icon_emoji_id": null,
       "unread_count": 3, "last_message_text": "..."}
    ]
  }
```

Errors: 404 if chat is not a forum-supergroup; 500 with `{detail: "..."}` on Pyrogram error.

### Edited: `GET /messages`

Add optional `topic_id: int | None`. When present, pass `message_thread_id=topic_id` to `client.get_chat_history`.

### Edited: `POST /send_message`

Add optional `message_thread_id: int | None` in payload. Pass through to `client.send_message`.

### Edited: `GET /queue?meta=true`

Each item gains:
```jsonc
{
  "chat_id": 12345,
  "folder_ids": [2, 5],
  "snooze_until": null,
  "topic_id": 7,                 // NEW (null for non-forum)
  "topic_title": "Bug reports",  // NEW (best-effort, may be null on cold cache)
  "last_message": {              // NEW — last message snapshot for queue card
    "id": 9876,
    "text": "...",
    "from_name": "Иван",
    "outgoing": false,
    "date": 1736...,
    "media_type": null           // see Spec B for population
  }
}
```

Backend assembles `last_message` by calling `client.get_chat_history(chat_id, limit=1)` per queue item, batched with `asyncio.gather`. To keep `/queue?meta=true` fast, results are cached via `TtlCache` (key `(account, chat_id)`, TTL 30s, invalidated on `queue_service.add/remove`).

### Edited: `GET /dialogs`

Each dialog gains `is_forum: bool`. Source: `chat.is_forum` from Pyrogram `Chat` object.

## Persistence

- `topics_service` cache is **in-memory** with TTL 60s (mirrors `folder_service`). Survives WS disconnects but lost on backend restart — that's fine, refetched on demand.
- `queue_service` JSON store unchanged (no new fields persisted).
- Frontend `messageCache` schema unchanged in this spec; topic-scoped messages still keyed by `chat_id` (we filter on render). Spec C revisits scaling.

## Edge cases

- **Topic deleted while user is on its ChatPage:** `get_chat_history` returns empty, send fails. Show toast «Тема не найдена» and redirect to `/chat/:id/topics`.
- **Forum-supergroup with no topics yet (rare):** TopicsPage shows empty state «В этой группе пока нет тем».
- **Outgoing handler firing for messages sent from another device:** by design that should also remove the chat from queue (user has handled it). No special-casing.
- **Race: user sends message; WS arrives before HTTP 200 of /send_message:** UI shows local optimistic copy + WS-driven confirmation. Already handled by existing send flow.
- **Topic icon emoji_id without resolved emoji:** fallback to colored circle with first character of title.

## Testing strategy

### Backend (pytest-asyncio)

- `tests/services/test_topics_service.py` — TTL cache hit/miss, error swallowing.
- `tests/handlers/test_incoming_outgoing.py` — outgoing message in queue → remove + broadcast; outgoing in non-queued chat → no-op.
- `tests/handlers/test_incoming_topics.py` — incoming in forum chat → broadcast carries `topic_id`, `topic_title` (cached).
- `tests/routers/test_topics.py` — happy path, 404 on non-forum, 500 on Pyrogram error.
- `tests/routers/test_messages_topic.py` — `topic_id` query forwards to Pyrogram with `message_thread_id`.
- `tests/routers/test_queue_meta.py` — meta=true includes `topic_*` and `last_message` fields.

### Frontend (vitest if configured, otherwise smoke via build)

- TaskFromChatForm: render with chatId=A, change to chatId=B → text input should show «Ответить B-name», not «Ответить A-name».
- QueueFilter: toggle Личные → only private chats remain; toggle Группы → only groups; both → both; none → all.
- TopicsPage: list renders; click → navigate to `/chat/X?topic_id=Y`.

## Test plan (manual)

1. Open queue with chats from multiple folders + forum-supergroups. Verify:
   - Header shows only «Разбор очереди» (no `1/N`).
   - Filter chips «Личные» / «Группы» work; folder chips work; combined works.
   - Archived chats never appear (already enforced).
2. Open a queued chat from queue card → answer → return. Chat should disappear from queue within ~1s.
3. From queue, click «В задачи» — form opens with «Ответить <correct chat title>». Skip to next chat, click «В задачи» again — form shows the **new** chat title.
4. Open a forum-supergroup from /message → TopicsPage opens with topic list. Click a topic → ChatPage shows only messages from that topic. Send a message → arrives in correct topic in Telegram.
5. New incoming message in a topic → queue card for that chat shows topic name «# General» above the text.
6. Group chat in queue → card shows author name above message text.

## Risks & mitigations

- **Pyrogram API mismatch:** `get_forum_topics` and `message_thread_id` kwarg confirmed available in Pyrogram ≥ 2.0.106. If older — feature flagged as no-op (TopicsPage empty, queue meta has null `topic_*`).
- **/queue?meta=true latency:** N parallel `get_chat_history(limit=1)` calls. Mitigation: TtlCache 30s + invalidate on add/remove. Worst case ~200ms for 20-chat queue, acceptable.
- **Outgoing handler double-removes:** if user already removed chat via «Готово» button, then sends a message, handler does `remove` again — safe (idempotent in `queue_service.remove`).
- **TaskFromChatForm key change:** unmount/remount discards in-progress edits. Acceptable: form is meant to be filled and submitted in one go; if user navigates away they lose their draft (matches current behavior elsewhere).

## Out of scope (future work)

- Multi-aspect dedup (one queue entry per (chat_id, topic_id)) — currently one chat = one queue entry regardless of which topic the new message arrived in.
- Topic-aware snooze (snooze a single topic).
- TopicsPage search.
