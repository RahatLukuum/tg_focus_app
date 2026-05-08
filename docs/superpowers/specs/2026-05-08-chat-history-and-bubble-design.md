# Spec C — Chat History & Bubble

**Date:** 2026-05-08
**Branch:** `denis-branch`
**Status:** draft (pending user review)
**Depends on:** Spec A (topic_id support in /messages); Spec B (MediaRenderer)

## Goal

Полная история сообщений, корректное отображение всех чатов (включая «Избранное»/Saved Messages), адаптивная рамка сообщения, чтобы длинные ссылки и слова не выходили за рамку.

Покрывает пункты пользователя:
- **#4** — баг: сообщение видно в списке чатов на главной, но не открывается в чате (особенно «Избранное»).
- **#9** — вся история чата (бесконечный скролл вверх).
- **#10** — рамка сообщения как в обычном Telegram (адаптивная ширина, перенос длинных слов/ссылок).

## Non-goals

- Поиск по сообщениям внутри чата.
- Reply-цитата (отображение сообщения, на которое отвечают). Уже есть тип `replyToMessage`, но рендер reply-блока — будущее.
- Закреплённые сообщения.
- Изменение `messageCache` под (chatId, topicId) ключ — для топиков остаёмся в одной IDB-записи на чат, фильтрация на render-side.

## Architecture

```
Backend
  routers/messages.py          [EDIT]   — /messages: всегда грузит запрошенный chat_id, без неявных фильтров. Если text_content и media_info оба пусты — сообщение пропускается; для Saved Messages этот фильтр **не применяется к outgoing-only сообщениям без текста** (пустых outgoing нет, безопасно).
  routers/messages.py          [EDIT]   — /messages позволяет limit ≤ 200; before_id корректно работает для пагинации в прошлое.

Frontend
  pages/ChatPage.tsx           [EDIT]   — top-of-list IntersectionObserver вместо scroll-pos handler; состояние loadingOlder; индикатор; полное удаление лимита в отображении
  pages/ChatPage.tsx           [EDIT]   — поддержка ?topic_id=N (Spec A) сквозная
  pages/ChatPage.tsx           [EDIT]   — render бабла через <MessageBubble> (extracted)
  pages/HomePage.tsx           [EDIT]   — Saved Messages chat (chat_id == me.id) явно показан, даже если бэк его не вернул в /dialogs (fallback)
  pages/MessagePage.tsx        [EDIT]   — то же
  components/chat/MessageBubble.tsx [NEW] — адаптивная рамка + render текст/медиа/время; ссылки кликабельны
  components/chat/MessageList.tsx   [REUSE] — есть в components/telegram, но в актуальной ChatPage используется inline; либо extract тут заново
  components/chat/useInfiniteScrollUp.ts [NEW] — хук для пагинации вверх
  services/messageCache.ts     [EDIT]   — MAX_MSGS_PER_CHAT 100 → 1000; добавить hasReachedBeginning?: boolean чтобы не дёргать backend на исчерпанной истории
  services/telegramApi.ts      [EDIT]   — getOlderMessages принимает limit до 200
  contexts/TelegramContext.tsx [EDIT]   — loadOlderMessages кеширует (сейчас не пишет в IndexedDB после прокрутки вверх)
```

## Bug #4 — Saved Messages investigation

### Hypothesis tree (исключаем по очереди)

1. **Saved Messages не появляется в списке /dialogs.**
   - Проверка: `client.get_dialogs()` Pyrogram возвращает Saved Messages как обычный private dialog с `chat.id == me.id`. Если pyrogram пропускает (бывает на cold sessions без последнего сообщения от себя), нужно дополнить /dialogs fallback'ом: после iterate dialogs если `me.id` отсутствует, запросить `client.get_chat(me.id)` и добавить вручную.
2. **Saved Messages показывается в /dialogs, но `/messages?chat_id=me.id` возвращает пустоту.**
   - Проверка: Pyrogram `get_chat_history(me.id)` работает, но в фильтре `text_content + media_info both empty → continue` могут отсеиваться сообщения (например, форварды с пустым текстом и неизвестным типом медиа). Решение: для self-chat снимаем фильтр пустоты.
3. **Frontend не находит self-chat в `state.chats` → ChatPage не находит контакт → не пытается отрисовать.**
   - Проверка: ChatPage сейчас:
     ```tsx
     const contact = state.chats.find(c => c.id === numericChatId) || state.contacts?.find(c => c.id === numericChatId);
     ```
     Если контакта нет, идёт fallback `getChatInfo(chat_id)` → `setRemoteChatTitle`. Но `state.isInitialized` блокирует первичную загрузку; для Saved Messages этот гард может срабатывать иначе.
4. **HomePage/MessagePage не показывают карточку Saved Messages даже если в /dialogs она есть** — рендер фильтрует по type или title.

### Resolution plan

1. **Backend `/dialogs`**: после цикла, если `me.id ∉ {dialog.chat.id}`, добавить вручную:
   ```python
   me = await client.get_me()
   if not any(d["chat_id"] == me.id for d in dialogs):
       try:
           saved = await client.get_chat(me.id)
           dialogs.append({
               "chat_id": me.id,
               "title": "Saved Messages",
               "type": "private",
               "username": getattr(saved, "username", None),
               "unread_count": 0,
               "last_message_text": None,
               "folder_id": 0,
               "is_saved_messages": True,
           })
       except Exception:
           logger.debug("Saved Messages fetch failed", exc_info=True)
   ```
2. **Backend `/messages`**: для self-chat (`chat_id == me.id`), снять фильтр `if not text_content and not media_info: continue`. Просто всегда добавляем сообщение в историю — пользователь сам себе шлёт всё что угодно, в том числе пустые форварды.
3. **Frontend `pages/HomePage.tsx`** и `pages/MessagePage.tsx`: явно показать Saved Messages с титулом «Избранное» или «Saved Messages» (как Telegram), икона = звёздочка/закладка.
4. **Frontend `ChatPage.tsx`**: убрать или ослабить `if (!state.isInitialized) return <Загрузка>`; рендерить непосредственно из cache + fetch. `state.isInitialized` нужен только для контактов/чатов листа, не для конкретного чата.

### Verification

Воспроизводимый сценарий: открыть приложение → войти под пользователем, у которого есть пара сообщений в Saved Messages → главная показывает «Избранное» → клик → ChatPage загружается, история отображается.

## Bug #10 — adaptive bubble

### Current

`ChatPage.tsx:473`:
```tsx
className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${...}`}
```

`max-w-xs` = 20rem = 320px. На широких экранах `lg:max-w-md` = 28rem = 448px.

Длинная ссылка вроде `https://example.com/very/long/path/with/many/parts?param=value&another=...` — это одно слово, которое не разбивается, и оно вылезает за пределы (`overflow-x` не задан).

### Fix — single bubble component

```tsx
// components/chat/MessageBubble.tsx
type Props = { message: UiMsg; isGroup: boolean; onLightbox: ...; };

export function MessageBubble({ message, isGroup, onLightbox }: Props) {
  return (
    <div className={`flex ${message.isOutgoing ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "px-4 py-2 rounded-2xl",
          // Adaptive width: max 75% of container on mobile, 60% on sm+
          "max-w-[85%] sm:max-w-[70%] md:max-w-[60%]",
          // Word wrapping: long URLs and words break at any character
          "break-words [overflow-wrap:anywhere]",
          message.isOutgoing
            ? "bg-primary text-primary-foreground"
            : "bg-muted",
        ].join(" ")}
      >
        {isGroup && !message.isOutgoing && message.senderName && (
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
        <p
          className={`text-[11px] mt-1 ${
            message.isOutgoing ? "text-primary-foreground/70" : "text-muted-foreground"
          }`}
        >
          {message.time}
        </p>
      </div>
    </div>
  );
}
```

`Linkify` is a tiny utility component that wraps URLs in `<a target="_blank" rel="noopener noreferrer" className="underline break-all">`.

### Why this works (Telegram-style)

- `max-w-[85%] sm:max-w-[70%] md:max-w-[60%]` — рамка занимает не больше доли от контейнера. Естественно сжимается на узких экранах, не растягивается на широких.
- `break-words [overflow-wrap:anywhere]` — длинные слова разбиваются по символам (URLs, hashes), но обычные предложения переносятся по словам.
- `whitespace-pre-wrap` — сохраняет переносы строк из исходного текста.
- Без `min-w` — рамка автоматически сжимается до контента (короткое «ок» → узкий пузырь, как в Telegram).
- `rounded-2xl` (16px) — ближе к Telegram's 18px, читабельнее на медиа.

## Feature #9 — infinite scroll

### Current

`ChatPage.tsx:261-271`:
```tsx
useEffect(() => {
  const el = listRef.current;
  if (!el) return;
  const onScroll = () => {
    if (el.scrollTop < 50) {
      loadOlderMessages(numericChatId).catch(() => {});
    }
  };
  el.addEventListener('scroll', onScroll);
  return () => el.removeEventListener('scroll', onScroll);
}, [numericChatId, loadOlderMessages]);
```

Issues:
1. No debounce — `loadOlderMessages` may fire multiple times during one scroll burst.
2. Result not cached — older pages aren't written back to IDB, so next chat-open reverts to short history.
3. No "reached beginning" tracking — keeps calling backend even when no more data.
4. Scroll position jumps after older messages are prepended.

### Fix — `useInfiniteScrollUp` hook

```ts
// components/chat/useInfiniteScrollUp.ts
export function useInfiniteScrollUp(opts: {
  containerRef: RefObject<HTMLDivElement>;
  onLoadMore: () => Promise<{ added: number }>;
  enabled: boolean;
  rootMargin?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const reachedTopRef = useRef(false);

  useEffect(() => {
    if (!opts.enabled || reachedTopRef.current) return;
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
            // Preserve scroll position: new content was prepended.
            requestAnimationFrame(() => {
              container.scrollTop =
                prevScrollTop + (container.scrollHeight - prevScrollHeight);
            });
          }
        } finally {
          loadingRef.current = false;
        }
      },
      { root: container, rootMargin: opts.rootMargin ?? "200px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [opts.enabled, opts.onLoadMore, opts.containerRef]);

  return { sentinelRef };
}
```

Usage in ChatPage:

```tsx
const { sentinelRef } = useInfiniteScrollUp({
  containerRef: listRef,
  onLoadMore: async () => {
    const firstId = state.messages[numericChatId]?.[0]?.id;
    if (!firstId) return { added: 0 };
    const older = await telegramApi.getOlderMessages(numericChatId, firstId, 100);
    if (older.length === 0) return { added: 0 };
    dispatch({
      type: "PREPEND_MESSAGES",
      payload: { chatId: numericChatId, messages: older },
    });
    await prependCached(numericChatId, older);
    return { added: older.length };
  },
  enabled: !!numericChatId,
});

// In the list:
<div ref={listRef} className="flex-1 overflow-y-auto p-4 pb-24 space-y-3">
  <div ref={sentinelRef} />
  {messages.map((m) => <MessageBubble key={m.id} ... />)}
  <div ref={bottomRef} />
</div>
```

### Cache changes

`messageCache.ts`:

```ts
const MAX_MSGS_PER_CHAT = 1000;   // up from 100

export async function prependCached(chatId: number, older: Message[]): Promise<void> {
  return withChatLock(chatId, async () => {
    const existing = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
    if (existing === null) return;            // same phantom-prevention
    const seen = new Set(existing.messages.map(m => m.id));
    const merged = [
      ...older.filter(m => !seen.has(m.id)),
      ...existing.messages,
    ];
    merged.sort((a, b) => a.id - b.id);
    const trimmed = merged.slice(-MAX_MSGS_PER_CHAT);   // keep newest
    await set(keyFor(chatId), { messages: trimmed, lastSyncAt: Date.now(), lastTouchedAt: Date.now() }, STORE);
  });
}
```

When trimming, keep the **newest** (slice tail). Older history beyond 1000 is re-fetchable from backend.

For chats the user actively scrolls up in, we may exceed 1000 in memory but trim to 1000 in IDB. Acceptable trade-off.

### Reducer

`TelegramContext` reducer adds:

```ts
case "PREPEND_MESSAGES": {
  const existing = state.messages[action.payload.chatId] ?? [];
  const seen = new Set(existing.map(m => m.id));
  const fresh = action.payload.messages.filter(m => !seen.has(m.id));
  return {
    ...state,
    messages: {
      ...state.messages,
      [action.payload.chatId]: [...fresh, ...existing].sort((a, b) => a.id - b.id),
    },
  };
}
```

## API surface

No new endpoints. Existing `/messages` already supports `before_id` for pagination — just needs `limit` raised to 200 and the Saved Messages exception (point 2 above).

## Edge cases

- **User scrolls to top of empty chat:** `getOlderMessages` returns `[]` → `reachedTopRef = true`, IO disconnects. No infinite loop.
- **Network blip during older fetch:** request fails, `loadingRef` resets in `finally`. Next intersection retries.
- **User receives new message while scrolled up:** `bottomRef` doesn't auto-scroll if user is far from bottom (existing logic at `el.scrollHeight - el.scrollTop - el.clientHeight < 200`). Keep.
- **Topic-scoped chat (Spec A):** `getOlderMessages` should pass `topic_id` if route has it. Add 4th arg.
- **Saved Messages with no messages:** ChatPage shows empty list; bottom input lets user start. `loadingOlder` short-circuits because `firstId` is undefined.
- **Long line (no spaces) wider than container:** `[overflow-wrap:anywhere]` covers it. Tested visually in spec.
- **Cache size grows:** trim tо 1000 in IDB; in-memory state.messages can exceed. Acceptable for active session.

## Testing strategy

### Backend

- `tests/routers/test_messages_saved.py` — `/messages?chat_id=<me.id>` returns messages (no empty filter for self-chat).
- `tests/routers/test_dialogs_saved.py` — `/dialogs` includes Saved Messages even if Pyrogram didn't list it.

### Frontend

- `useInfiniteScrollUp` hook test (vitest + jsdom): mock IntersectionObserver, simulate visibility, assert `onLoadMore` called once even on re-fires; assert scrollTop preserved.
- `MessageBubble` snapshot tests for short text, long URL, group sender, media.
- `prependCached` test: existing 50 msgs + 30 older → 80 in cache, sorted, no dupes.

## Test plan (manual)

1. Open «Избранное» from /home → ChatPage loads, shows full history (was empty before).
2. Send several messages to Saved Messages from official Telegram → they appear in our app within ~1s (WS) and after refresh.
3. In any chat: paste a 200-char URL into a message and receive/send it. The bubble doesn't overflow; URL wraps; click → opens in new tab.
4. In any chat with >100 messages: scroll up. Older messages load smoothly; scroll position stays anchored. Continue scrolling — eventually reaches the very first message (no infinite spinner).
5. Reload the page. The chat re-opens with cached messages immediately; delta-sync fills new ones; scroll up still works against backend pagination.
6. Send a 1-char message «ok» → bubble shrinks to fit (~30px wide), not full width.
7. Send a 500-char paragraph → bubble grows up to `60-85%` of container, then wraps internally.
8. In a topic-scoped chat (Spec A): scroll up → only that topic's older messages load.

## Risks & mitigations

- **`overflow-wrap: anywhere` not in older Tailwind versions:** if Tailwind <3.3, use arbitrary value `[overflow-wrap:anywhere]` (already in code above). Confirmed supported.
- **`prependCached` race with `appendCached`:** both use `withChatLock`, serialized. Safe.
- **IntersectionObserver missing on old browsers:** fallback to scroll handler (current behavior). Detect via `typeof IntersectionObserver !== "undefined"`.
- **Saved Messages bug remains after fix list:** capture network request manually during voucher reproduction; add specific log lines on backend with `logger.debug("saved messages history empty for me=%s", me.id)` to narrow down. Update spec if root cause turns out elsewhere.
- **Bundle size from Linkify:** trivial — built-in regex replacement, no library.

## Out of scope

- Reply-quote rendering (showing the message being replied to).
- Forwarded message header (forward source).
- Pinned message banner.
- Message search.
