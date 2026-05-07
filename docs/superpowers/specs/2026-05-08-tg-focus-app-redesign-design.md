# tg_focus_app — рефакторинг + 7 фич + persist

**Дата:** 2026-05-08
**Автор:** Claude (по запросу dengud79@gmail.com)
**Подход:** A — точечные правки в текущей архитектуре с разрешением переписывать раздутые файлы с нуля.

---

## 1. Цель и объём

Закрыть 7 пользовательских пунктов и связанные с ними рефакторинги:

1. Моментальная подгрузка сообщений как в Telegram (включая фикс `{"detail":"Not Found"}` после refresh).
2. Починить добавление чатов в список задач (сейчас кнопка `task` только перемещает чат в конец очереди — задачи не создаёт).
3. Чаты из всех папок Telegram должны попадать в очередь (сейчас фильтруются только `private` с `unread > 0`).
4. Папки Telegram должны появиться в `MessagePage` (раздел «написать сообщение»).
5. Заменить вкладки Личные/Группы/Контакты на multi-select чипы фильтров в `MessagePage` и добавить чипы папок в `QueuePage`.
6. В разборе очереди показывать, из какой папки чат.
7. Починить генерацию ответа через Claude API (старый model id, нет caching, нет retry).

Дополнительно (вне 7 пунктов, обнаружено в ходе вопросов):

8. Persist всех состояний (очередь, snooze, задачи) между перезапусками бэкенда — сейчас всё in-memory.

Не входит в этот spec: миграция бэкенда на SQLite (это отдельный проект, если потребуется), переписывание `TelegramContext` на TanStack Query (тоже отдельный), Tauri-улучшения, новые типы медиа, групповые чаты в чате (composer/preview).

---

## 2. Целевое состояние

### Пользовательский опыт

- **Открытие чата:** мгновенный показ кэшированной истории (IndexedDB) с фоновой догрузкой дельты.
- **Очередь:** prefetch следующего чата, переход done/snooze/skip без ожидания.
- **Новые сообщения:** WS-event несёт payload, фронт обновляется без round-trip к `/queue`.
- **Refresh любой страницы:** SPA загружается корректно, не показывает `{"detail":"Not Found"}`.
- **Список папок:** виден в `MessagePage` (чипы) и `QueuePage` (фильтр + метка папки на карточке).
- **Очередь покрывает все типы чатов** (private + group + supergroup) кроме архивных, из любых пользовательских папок.
- **4 действия в QueuePage:** Done / Snooze (с выбором времени) / Task (создаёт задачу + опционально снимает чат) / Skip (в конец очереди).
- **TodoPage** показывает задачи с сервера, задачи привязанные к чату — кликабельны и ведут в чат.
- **Persist:** после деплоя/рестарта бэка очередь, snooze и задачи на месте.
- **AI-ответ:** Haiku 4.5, ошибки маппятся на понятные коды (429/503/502), есть автоматический retry на 429/5xx.

### Технические инварианты

- Файлы ≤ 400 строк (правило `coding-style.md`).
- Все мутации persistence — через atomic-rename + asyncio.Lock.
- API endpoints обратно совместимы (старые поля остаются, новые добавляются).
- Pyrogram MTProto + multi-account — не меняем, переезжает в `pyrogram_clients.py`.

---

## 3. Архитектура

### Бэкенд (декомпозиция `backend/main.py`)

```
backend/
├── main.py                       # FastAPI app + lifecycle, ≤80 строк
├── config.py                     # @dataclass(frozen=True) AppConfig из env
├── deps/
│   ├── pyrogram_clients.py       # multi-account client manager
│   └── auth.py                   # get_authorized_client dependency
├── routers/
│   ├── auth.py                   # /auth/send_code, /auth/sign_in
│   ├── dialogs.py                # /dialogs, /contacts, /chat_info, /bootstrap
│   ├── messages.py               # /messages, /messages/since, /send_message, /media/*, /send_media
│   ├── queue.py                  # /queue, /queue/action
│   ├── tasks.py                  # /tasks (CRUD)            ─ NEW
│   ├── folders.py                # /folders                 ─ NEW
│   └── ai.py                     # /generate_reply
├── services/
│   ├── queue_service.py          # in-memory + persist через JsonStore
│   ├── folder_service.py         # raw GetDialogFilters + кэш TTL=60s
│   ├── task_store.py             # JSON-persist задач
│   ├── claude_client.py          # AsyncAnthropic + caching + retry
│   ├── state_store.py            # generic JsonStore с atomic write + asyncio.Lock
│   └── media_utils.py            # _extract_media_info + mime helpers
├── ws/
│   └── broadcaster.py            # connected_clients set + broadcast()
└── handlers/
    └── incoming.py               # MessageHandler attach (private + groups, не архив)
```

### Фронтенд (декомпозиция страниц)

```
frontend/src/
├── pages/
│   ├── QueuePage.tsx                 # ≤200 строк, композиция
│   ├── ChatPage.tsx                  # ≤250 строк
│   └── MessagePage.tsx               # ≤200 строк
├── components/queue/
│   ├── QueueHeader.tsx
│   ├── QueueDialogCard.tsx
│   ├── QueueActionsBar.tsx           # 4 кнопки: Done / Snooze / Task / Skip
│   ├── QueueFolderFilter.tsx         # NEW: чипы папок
│   ├── SnoozePopup.tsx               # NEW: 1ч / 4ч / Завтра / Кастом
│   ├── TaskFromChatForm.tsx          # NEW: создать задачу из чата
│   └── VoiceMessage.tsx              # вынести из QueuePage
├── components/chat/
│   ├── ChatHeader.tsx
│   ├── ChatMessageList.tsx
│   ├── ChatComposer.tsx
│   └── MediaPreviewModal.tsx
├── components/message/
│   └── ContactsFilter.tsx            # NEW: multi-select чипы
├── hooks/
│   ├── useMessageCache.ts            # NEW: IndexedDB-кэш истории
│   ├── usePrefetchQueue.ts           # NEW: prefetch соседних чатов
│   ├── useFolders.ts                 # NEW: список папок + chat→folders map
│   └── useChipFilter.ts              # NEW: multi-select state
├── services/
│   ├── telegramApi.ts
│   ├── tasksApi.ts                   # NEW
│   └── foldersApi.ts                 # NEW
└── contexts/
    └── TelegramContext.tsx           # ≤300 строк, WS-логика выносится в useTelegramSocket
```

---

## 4. Разделы по пунктам

### 4.1 Пункт 1 — моментальная подгрузка + refresh-fix

**Локальный кэш** (`hooks/useMessageCache.ts`): IndexedDB через `idb-keyval`. Ключ `chat:{chat_id}` → `{messages: Message[], lastSyncAt: number}`. LRU: до 50 чатов, 100 сообщений на чат.

**Поток открытия чата:**
1. UI рендерит из кэша (если есть) — мгновенно.
2. Параллельно `GET /messages/since?chat_id=X&since_id=lastKnownId`.
3. Дельта мерджится в state и кэш.

**Prefetch в QueuePage** (`hooks/usePrefetchQueue.ts`): при `currentIndex` фоном грузим N+1 и N+2 (debounce 300мс).

**Оптимистичный рендер новых сообщений:** WS-event теперь несёт полный preview (как сейчас), фронт добавляет в `state.messages[chatId]` и в `queueIds` локально. Запрос `/queue` после WS — только как fallback на ошибки.

**Бэкенд — ускорение `/messages`:**
- TTL=10s memory cache `Dict[chat_id, (timestamp, payload)]`.
- Новый `GET /messages/since?chat_id=X&since_id=Y&limit=50` — только новые сообщения.

**Бэкенд — ускорение `/bootstrap`:**
- Снэпшот ответа в памяти TTL=30s. Refresh страницы → второй вызов мгновенный.

**Refresh-bug `{"detail":"Not Found"}`:**
Двухуровневое решение, выбирается одно из двух при имплементации:

1. **Предпочтительно — фикс в nginx на VPS**: добавить `try_files $uri $uri/ /index.html;` в location блок фронтенда. Это правильное место для SPA-fallback в продакшен-конфиге. Перед имплементацией читаем текущий `nginx.conf` на VPS (через ssh).

2. **Fallback — catch-all в FastAPI** (если nginx-конфиг недоступен или фронт обслуживается напрямую FastAPI через `/app` mount):
```python
API_PATH_PREFIXES = ("auth/", "ws", "media/", "queue", "tasks", "folders",
                     "dialogs", "messages", "send_message", "send_media",
                     "bootstrap", "contacts", "chat_info", "me",
                     "generate_reply", "resolve_contact", "healthz", "docs",
                     "openapi.json", "app/")

@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if full_path.startswith(API_PATH_PREFIXES):
        raise HTTPException(404)
    index = DIST_DIR / "index.html"
    if not index.exists():
        raise HTTPException(404)
    return FileResponse(str(index))
```
Регистрируется **последним**, после всех роутеров и WS endpoint'а. WS на пути `/ws` маршрутизируется до catch-all потому что FastAPI приоритизирует более специфичные маршруты.

### 4.2 Пункт 2 — задачи (две кнопки в QueuePage)

**Бэкенд** — `services/task_store.py` + `routers/tasks.py`:
```
GET    /tasks?account=
POST   /tasks                  {text, chat_id?, chat_title?, account?}
PATCH  /tasks/{id}             {done?, text?}
DELETE /tasks/{id}
DELETE /tasks/completed?account=
```

Persist: `backend/sessions/tasks.json`. Структура: `[{id, text, done, created_at, chat_id, chat_title, account}]`.

**Фронтенд:**
- `QueueActionsBar` — 4 кнопки: Done / Snooze / Task / Skip.
- Клик по Task открывает `TaskFromChatForm`: prefilled text «Ответить {chat_title}», чекбокс «также убрать из очереди».
- `TodoPage` мигрирует с localStorage на `/tasks` (миграция localStorage → API один раз при первом открытии).
- Задачи с `chat_id != null` рендерятся как кликабельная плашка `[💬 {chat_title}] {text}` → `/chat/{chat_id}`.

**Snooze** (отдельная кнопка):
- `routers/queue.py` POST `/queue/action {action: 'snooze', snooze_until: ts}`.
- `services/queue_service.py` хранит `snoozed: Dict[account, Dict[chat_id, until_ts]]`.
- Background worker раз в 30s возвращает чаты с истёкшим snooze + бродкастит `queue_update`.

### 4.3 Пункт 3 — чаты из всех папок в очереди

**Источник проблемы**: текущий handler в [backend/main.py:192-204](backend/main.py#L192-L204) фильтрует `type_name != "private"` → groups/supergroups никогда не попадают в очередь. И `build_dialogs_and_queue` фильтрует `item["type"] == "private"` ([backend/main.py:425](backend/main.py#L425)).

**Изменения:**
- Incoming-handler: убрать фильтр `private`. Принимать все incoming, кроме сервисных и из архивных папок.
- `build_dialogs_and_queue`: убрать фильтр `private`. Включать все диалоги с `unread > 0` кроме архивных.
- Архивность определяется через `folder_service` (Telegram archive folder в Pyrogram доступен через `folder_id == 1`; точная константа уточняется при имплементации против `pyrogram.raw.types`).

### 4.4 Пункт 4 — папки в MessagePage (+ folder_service)

**Бэкенд** — `services/folder_service.py`:
- Использует `from pyrogram.raw.functions.messages import GetDialogFilters`.
- Per-account кэш с TTL=60s.
- Возвращает `{folders: [{id, title, chat_ids}], chat_to_folders: {chat_id: [folder_id...]}}`.
- Архив (id=1 / `DialogFilterDefault` без условий) исключается на выходе.

**Endpoint** — `GET /folders?account=`.

**Расширение существующих:**
- `GET /dialogs` и `GET /bootstrap` — каждый dialog получает `folder_ids: int[]`.
- `GET /queue` — добавить опциональное `?meta=true`, тогда возвращает `{queue: [{chat_id, folder_ids}]}`. Старая форма `{queue: [int]}` остаётся при `meta=false`/отсутствии параметра.

**Фронтенд** — `hooks/useFolders.ts`:
```ts
const { folders, chatToFolders, isLoading } = useFolders();
```
Загружается один раз на AppShell, инвалидируется при WS-событии `folders_changed` (опционально, если придёт `UpdateDialogFilter` от Telegram).

### 4.5 Пункт 5 — чипы вместо вкладок + чипы папок

**MessagePage** ([components/message/ContactsFilter.tsx](frontend/src/components/message/ContactsFilter.tsx)):
- Удаляются три вкладки (Личные/Группы/Контакты).
- Добавляются две группы чипов:
  - Тип: `[Личные] [Группы] [Контакты]` — multi-select.
  - Папка: `[Папка 1] [Папка 2] ...` — multi-select. Не показываются если `folders.length == 0`.
- При пустом наборе фильтров → показ всего.
- Persist выбора в localStorage `message_filter`.

**QueuePage** (`components/queue/QueueFolderFilter.tsx`):
- Компактная панель чипов под header'ом: `[Все папки] [Папка 1] [Папка 2]`.
- Применение фильтра — на фронте через `chatToFolders`, не round-trip к бэку.
- Persist в localStorage `queue_folder_filter`.

### 4.6 Пункт 6 — отображение папки в карточке очереди

В [QueuePage.tsx](frontend/src/pages/QueuePage.tsx) карточке текущего чата под именем добавляется строка:
```
Иван Петров
📁 Работа · Друзья
```
Источник — `chatToFolders[chatId]` × `folders.find(f => f.id === id).title`. Если у чата нет папок — строка не рендерится.

### 4.7 Пункт 7 — Claude API: Haiku 4.5 + caching + retry

**Зависимости:** добавить `anthropic>=0.40.0` в `backend/requirements.txt`.

**`services/claude_client.py`:**
```python
@dataclass(frozen=True)
class ClaudeConfig:
    api_key: str
    model: str = "claude-haiku-4-5"
    max_tokens: int = 1024


class ClaudeClient:
    def __init__(self, cfg: ClaudeConfig) -> None:
        self._cfg = cfg
        self._client = AsyncAnthropic(api_key=cfg.api_key, max_retries=3)

    async def generate_reply(
        self, history: list[dict], system_prompt: str | None = None
    ) -> str:
        sys_text = system_prompt or DEFAULT_SYSTEM
        resp = await self._client.messages.create(
            model=self._cfg.model,
            max_tokens=self._cfg.max_tokens,
            system=[{
                "type": "text",
                "text": sys_text,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=history,
        )
        return "\n".join(b.text for b in resp.content if b.type == "text").strip()
```

**Endpoint `routers/ai.py`:**
- Маппинг ошибок: `rate_limit_error` → 429, `overloaded_error` → 503, прочие → 502.
- Логирование `e.type` + `e.status_code` для дебага.

**Что улучшилось vs текущий код:**

| Было | Стало |
|---|---|
| `claude-sonnet-4-20250514` (старый id) | `claude-haiku-4-5` (~5× дешевле) |
| Сырой `httpx` | Официальный SDK с типизированными исключениями |
| Нет prompt caching | `cache_control: ephemeral` на system |
| Нет retry — 429 сразу 502 | SDK auto-retry 3× с exponential backoff |
| Все ошибки → 500/502 | Маппинг по типу ошибки |
| System hardcoded в endpoint | Конфигурируемый, default в client'е |

### 4.8 Persist состояний (раздел 6)

**`services/state_store.py`** — generic `JsonStore[T]`:
- `load()`, `save(data)`, `update(mutator)` — все под `asyncio.Lock`.
- Atomic write: temp-file + rename. При повреждённом JSON — log error, использовать default, переименовать сломанный файл в `.corrupted-<ts>`.

**Файлы:**
- `backend/sessions/tasks.json` — список задач.
- `backend/sessions/queue_state.json` — `{queues: {account: [chat_id]}, snoozed: {account: {chat_id: until_ts}}}`.

**Bootstrap при старте FastAPI:**
- `restore_state()` подгружает state в `queue_service` и `task_store`.
- `start_snooze_worker()` запускает background task раз в 30s.

---

## 5. Изменения API (контракт)

### Новые endpoints

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/folders?account=` | Список папок + map chat→folders |
| GET | `/messages/since?chat_id=X&since_id=Y&limit=50` | Дельта-синк сообщений |
| GET | `/tasks?account=` | Список задач |
| POST | `/tasks` | Создать задачу |
| PATCH | `/tasks/{id}` | Обновить задачу (done/text) |
| DELETE | `/tasks/{id}` | Удалить задачу |
| DELETE | `/tasks/completed?account=` | Очистить выполненные |

### Расширение существующих

| Endpoint | Что меняется | Совместимость |
|---|---|---|
| `GET /dialogs` | Каждый dialog получает `folder_ids: int[]` | Новое поле — старый фронт игнорирует |
| `GET /bootstrap` | Каждый dialog `folder_ids: int[]` + `folders` блок | Новые поля — старый фронт игнорирует |
| `GET /queue?meta=true` | Возвращает `{queue: [{chat_id, folder_ids}]}` | Без `meta=true` — старый формат `{queue: [int]}` |
| `POST /queue/action` | Поддержка `action: 'snooze'` + `snooze_until: ts` | Старые actions работают |
| `POST /generate_reply` | Маппинг ошибок: 429/503/502 | Поведение success-пути не меняется |

### SPA-fallback

`GET /{full_path:path}` ловит всё, что не префикс API/WS/media → отдаёт `index.html`. Новый catch-all route, регистрируется последним.

---

## 6. Структуры данных

### Task
```python
@dataclass(frozen=True)
class Task:
    id: str               # uuid4
    text: str
    done: bool
    created_at: int       # unix timestamp
    chat_id: int | None = None
    chat_title: str | None = None
    account: str | None = None
```

### Queue state on disk
```json
{
  "queues": {
    "+71234567890": [-1001234567, 5678901234],
    "": [-1001234569]
  },
  "snoozed": {
    "+71234567890": {"-1001234567": 1714000000}
  }
}
```

### Folder service output
```python
{
  "folders": [
    {"id": 2, "title": "Работа", "chat_ids": [...]},
    {"id": 3, "title": "Друзья", "chat_ids": [...]}
  ],
  "chat_to_folders": {
    "-1001234567": [2, 3],
    "5678901234": [2]
  }
}
```
Архив (`folder_id == 1`) и `DialogFilterDefault` (All chats) исключаются.

### Message cache (IndexedDB)
```
Key: "chat:{chat_id}"
Value: {messages: Message[], lastSyncAt: number}
```

---

## 7. Edge cases и обработка ошибок

| Кейс | Поведение |
|---|---|
| Аккаунт без папок | `folders: []`, чипы папок не отображаются, чипы по типам остаются |
| Чат не в одной папке | `folder_ids: []`, при включённом фильтре по папкам не виден; при пустых фильтрах — виден |
| Удалённая папка в localStorage | Невалидный id игнорируется при отрисовке |
| Snooze на прошедшее время | 400 с понятной ошибкой |
| Task для удалённого чата | Задача остаётся, при клике на плашку — toast «Чат недоступен» |
| Race: Done + WS queue_update в одну миллисекунду | Optimistic remove на клиенте, WS для этого `chat_id` игнорируется ~3s |
| `tasks.json` повреждён | Log error, default empty list, переименовать в `.corrupted-{ts}` |
| Параллельные мутации state | `asyncio.Lock` per-store, операции сериализуются |
| Half-written файл при kill -9 | Atomic rename защищает: либо старый, либо новый |
| Cache miss на короткий system prompt | Минимум для caching на Haiku 4.5 — 4096 tokens, короткий system не закэшируется. Это нейтрально, маркер безопасен (harmless) |
| Refresh на пути `/chat/123` | SPA-fallback отдаёт `index.html`, React Router маршрутизирует клиентски |
| Сервис без `ANTHROPIC_API_KEY` | `/generate_reply` возвращает 500 «not configured» (как сейчас) |
| Telegram отозвал session | 401 с понятной ошибкой, фронт редиректит на /auth |

---

## 8. Тестирование

Проект сейчас не содержит автотестов. В рамках этого spec'а **минимальный** тест-набор для критичных мест:

- `services/state_store.py` — тесты на atomic write, восстановление после corrupted JSON, конкурентные мутации.
- `services/queue_service.py` — тесты на add/remove/snooze/expire, persist round-trip.
- `services/task_store.py` — CRUD round-trip.
- `services/folder_service.py` — мок Pyrogram raw API, проверка фильтрации архива.
- `routers/queue.py` — тесты handler'а на правильный формат с/без `meta=true`.

Ручная проверка после деплоя:
1. Refresh на `/chat/123` → загружается, не Not Found.
2. Открытие чата второй раз → мгновенно из кэша.
3. Новое сообщение в группе → попадает в очередь.
4. Кнопка Task в QueuePage → задача в TodoPage кликабельна.
5. Snooze на 1ч → чат пропадает из очереди, через 1ч+30s возвращается.
6. Generate AI reply → быстрый ответ, в логах видно `cache_creation_input_tokens` либо `cache_read_input_tokens`.
7. Рестарт `docker compose restart` → задачи и очередь на месте.

---

## 9. Миграция и rollout

### Подготовка
- Бэкап текущих `.session` файлов в `backend/sessions/` (на VPS).
- На фронте: миграция `localStorage[tg_focus_todos]` → POST `/tasks` батчем при первом монтировании TodoPage; localStorage очищается после успешной миграции.

### Порядок выкладки
1. Деплоить бэкенд (новые endpoints добавляются, старые остаются совместимыми).
2. Через 1-2 минуты деплоить фронтенд.
3. Старый формат `{queue: [int]}` поддерживается ещё 1-2 релиза, потом удалится.

### Rollback
- `git revert` коммитов deploy-ветки + redeploy.
- `tasks.json` и `queue_state.json` сами по себе — обратно совместимы (старый код их просто проигнорирует).

---

## 10. Что вне scope этого spec'а

- Перевод `TelegramContext` на TanStack Query.
- Миграция backend state на SQLite.
- Активная работа с Tauri-shell (упаковка/подпись).
- Поддержка Bot API (сейчас только MTProto через Pyrogram).
- Голосовые ответы из AI.
- Push-нотификации.
- Продвинутая модерация / антиспам очереди.

Каждый из этих пунктов — отдельный spec, если потребуется.

---

## 11. Контракт между этим spec'ом и implementation plan

Когда мы перейдём к `writing-plans`, имплементация будет разбита на фазы:
1. Декомпозиция бэка (без изменения логики) → деплой → проверка регрессий.
2. `state_store` + `task_store` + endpoint `/tasks` → деплой → миграция localStorage.
3. `folder_service` + endpoint `/folders` + `folder_ids` в `/dialogs` → деплой.
4. Расширение очереди (groups + папки) + UI чипы папок → деплой.
5. Кэш сообщений + prefetch + WS-payload + SPA-fallback → деплой.
6. Snooze + 4 кнопки в QueuePage → деплой.
7. Декомпозиция QueuePage/MessagePage/ChatPage + чипы фильтров → деплой.
8. Claude SDK + Haiku 4.5 + caching + retry → деплой.

Каждая фаза — самодостаточный merge-ready PR.
