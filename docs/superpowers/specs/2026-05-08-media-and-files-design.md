# Spec B — Media & Files

**Date:** 2026-05-08
**Branch:** `denis-branch`
**Status:** draft (pending user review)
**Depends on:** Spec A (uses `last_message` field added to `/queue?meta=true`)

## Goal

Полная поддержка вложений на всех экранах: voice, video-note (кружки), произвольные файлы (документы, аудио). Отправка из приложения. Скачивание. Превью на карточке очереди и lightbox по клику.

Покрывает пункты пользователя:
- **#2** — voice + video-note: плеер на карточке разбора очереди и в чате.
- **#7** — произвольные файлы: отправка из приложения (любой тип), отображение в чате, скачивание.
- **#8** — медиа в разборе очереди: превью + клик раскрывает полный просмотр (lightbox/full-screen player).

## Non-goals

- Запись video-note в браузере (нужна камера + специфический формат). Воспроизводим уже полученные кружки, но запись — кнопка отсутствует.
- Стикеры и анимированные эмодзи — отдельная история, не сейчас.
- Inline-альбомы (несколько фото в одном сообщении) — рендерим первое медиа (как сейчас); полные альбомы — будущее.
- Транскрипция голосовых — отказались (выбрана опция «только плеер»).

## Architecture

```
Backend
  services/media_utils.py        [EDIT]   — video_note → media_type="video_note" (был "video"); document → mime_type, file_size; audio (non-voice) → media_type="audio"
  routers/messages.py            [EDIT]   — /send_media: добавить media_type="video_note" и "audio" → send_video_note / send_audio; /send_media: пробрасывать message_thread_id для тематических чатов
  routers/messages.py            [EDIT]   — /messages и /messages/since возвращают thumbnail_url для photo/video, file_size для document/audio

Frontend
  components/media/MediaRenderer.tsx [NEW]
      Single dispatch by mediaType:
        photo       → <img> + lightbox onclick
        video       → <video controls> + lightbox onclick
        video_note  → круглый <video> 240×240 + lightbox
        voice       → <VoiceMessage>
        audio       → <AudioPlayer> с file_name + duration
        document    → <FileChip> with icon, name, size, download button
  components/media/VoiceMessage.tsx  [EXTRACT] — общий плеер из QueuePage/ChatPage
  components/media/AudioPlayer.tsx   [NEW]
  components/media/FileChip.tsx      [NEW]
  components/media/Lightbox.tsx      [EXTRACT] — общий полноэкранный просмотрщик
  components/media/AttachMenu.tsx    [NEW]    — заменяет двухкнопочный showAttach (Фото/Видео); добавляет «Файл» (любой тип)
  pages/QueuePage.tsx                [EDIT]   — currentDialog.lastMessage показывает MediaRenderer
  pages/ChatPage.tsx                 [EDIT]   — использует общий MediaRenderer вместо локальной renderMedia
  services/telegramApi.ts            [EDIT]   — sendMedia принимает 'video_note' | 'audio' | 'document'
  types/telegram.ts                  [EDIT]   — MediaType += 'video_note' | 'audio'; Message.fileSize?: number; Message.mimeType?: string
```

## Backend changes

### `services/media_utils.py`

Current bug: `video_note` is conflated with `video`. Fix:

```python
elif message.video_note:
    media_type = "video_note"          # was "video"
    duration = getattr(message.video_note, "duration", None)
elif message.audio:                    # NEW branch
    media_type = "audio"
    duration = getattr(message.audio, "duration", None)
    file_name = getattr(message.audio, "file_name", None)
elif message.document:
    media_type = "document"
    file_name = getattr(message.document, "file_name", None)
    file_size = getattr(message.document, "file_size", None)        # NEW
    mime_type = getattr(message.document, "mime_type", None)        # NEW
```

Result dict keys: `media_type, media_url, file_name?, duration?, file_size?, mime_type?`.

Order matters: `audio` must be checked before `document`, because audio messages also have a `document` field on Pyrogram in some cases. Confirm: Pyrogram exposes `message.audio` as a separate top-level attribute distinct from `message.document` for audio files — this branch ordering is correct.

### `routers/messages.py`

`/send_media` currently supports `photo | video | voice | document`. Extend:

```python
elif media_type == "video_note":
    sent = await client.send_video_note(chat_id=chat_id, video_note=tmp_path)
elif media_type == "audio":
    sent = await client.send_audio(chat_id=chat_id, audio=tmp_path, caption=caption or None)
```

Note: `send_video_note` accepts no caption (Telegram limitation) — ignore the `caption` form field for that type. Document the constraint in error responses.

`/send_media` add optional `message_thread_id: Optional[int] = Form(None)` and pass through to all `send_*` calls. Mirror change is in `/send_message` from Spec A.

`/media/{chat_id}/{message_id}` — content-type mapping: add `audio/mpeg` (or use `mime_type` from message), keep `video/mp4` for video_note. Already returns `application/octet-stream` for unknown documents — fine.

### `/messages` payload

New field per message (when applicable):
```jsonc
{
  "id": 12345,
  ...,
  "media_type": "audio",
  "media_url": "/media/-100../12345",
  "file_name": "podcast.mp3",
  "duration": 1830,
  "file_size": 18432000,
  "mime_type": "audio/mpeg"
}
```

## Frontend components

### `MediaRenderer.tsx` — single source of truth

Replaces duplicated `renderMedia` in QueuePage and ChatPage.

```tsx
type Props = {
  mediaType: MediaType;
  mediaUrl: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  onLightbox?: (url: string, type: "photo" | "video" | "video_note") => void;
};

export function MediaRenderer(props: Props) {
  switch (props.mediaType) {
    case "photo":      return <PhotoView {...props} />;
    case "video":      return <VideoView {...props} />;
    case "video_note": return <VideoNoteView {...props} />;
    case "voice":      return <VoiceMessage url={props.mediaUrl} duration={props.duration} />;
    case "audio":      return <AudioPlayer {...props} />;
    case "document":   return <FileChip {...props} />;
  }
}
```

### `VideoNoteView`

Telegram-style круглый видеоплеер 240×240, autoplay muted on visible, loop. Click → lightbox with audio.

```tsx
<video
  src={`${url}#t=0.001`}
  className="rounded-full w-60 h-60 object-cover"
  autoPlay muted loop playsInline preload="metadata"
  onClick={() => onLightbox(url, "video_note")}
/>
```

### `AudioPlayer`

Same UX as `VoiceMessage` but with file name and «трек длиной N:NN»:

```
┌─────────────────────────────────────┐
│ [▶] ━━━━━━●─────────  podcast.mp3   │
│           1:42 / 30:30   18.4 MB    │
└─────────────────────────────────────┘
```

### `FileChip`

```tsx
<a
  href={mediaUrl}
  download={fileName}
  className="flex items-center gap-3 p-3 bg-background/50 rounded-lg border ..."
>
  <FileIcon mime={mimeType} />
  <div className="flex flex-col min-w-0">
    <span className="font-medium truncate">{fileName ?? "Файл"}</span>
    <span className="text-xs text-muted-foreground">{formatSize(fileSize)}</span>
  </div>
  <Download className="ml-auto h-4 w-4 opacity-60" />
</a>
```

`FileIcon` renders a colored badge with extension text (`PDF`, `DOC`, `ZIP`, ...) derived from `fileName` extension or `mimeType`.

### `AttachMenu`

Replaces the inline showAttach in QueuePage and ChatPage:

```tsx
<AttachMenu
  onPickPhoto={() => imgInput.current?.click()}
  onPickVideo={() => vidInput.current?.click()}
  onPickFile={() => fileInput.current?.click()}
/>

<input ref={fileInput} type="file" hidden onChange={(e) => {
  const f = e.target.files?.[0];
  if (f) openPreview(f, "document");
  e.target.value = "";
}} />
```

`openPreview` for `document`: skip image preview, show name + size + caption input + Send.

### Queue card with media (#8)

Currently `currentDialog.lastMessage` is a plain string. Replace the bubble:

```tsx
<div className="bg-muted p-4 rounded-lg space-y-2">
  {topicTitle && <p className="text-[11px] uppercase tracking-wide text-muted-foreground"># {topicTitle}</p>}
  {isGroup && lastMsg?.senderName && (
    <p className="text-xs font-semibold text-blue-500">{lastMsg.senderName}</p>
  )}
  {lastMsg?.mediaType && lastMsg.mediaUrl && (
    <MediaRenderer
      mediaType={lastMsg.mediaType}
      mediaUrl={lastMsg.mediaUrl}
      fileName={lastMsg.fileName}
      fileSize={lastMsg.fileSize}
      mimeType={lastMsg.mimeType}
      duration={lastMsg.duration}
      onLightbox={setFullscreenMedia}
    />
  )}
  {lastMsg?.text && <p className="text-sm">{lastMsg.text}</p>}
  <p className="text-xs text-muted-foreground mt-2">{lastMsg?.time}</p>
</div>
```

`lastMsg` is the last item of `state.messages[currentChatId]` (already loaded via cache-first useEffect). Falls back to `/queue?meta=true` `last_message` field if local cache is empty (rare race on first paint).

## Send paths

### Universal flow

```
User clicks 📎 → AttachMenu opens → picks file
            → openPreview(file, type) sets previewFile/previewType
            → modal shows preview (image/video) or filename+size (doc/audio)
            → user adds caption + clicks Send
            → telegramApi.sendMedia(chatId, file, type, caption, topicId?)
            → POST /send_media (multipart, max 50 MB by frontend assertion)
            → on success: dispatch ADD_MESSAGE with optimistic data; WS will reconcile
```

Frontend size guard: `if (file.size > 50 * 1024 * 1024) toast.error("Файл больше 50 MB не отправляется")`. Server enforces no extra limit (Telegram itself supports up to 2 GB but we cap at 50 MB to avoid uvicorn buffer issues).

### Voice / video-note recording

Voice recording stays as-is (existing MediaRecorder flow). Video-note recording **deferred** — out of scope.

## Lightbox behaviors

- **photo:** `<img>` cover, click outside or ESC closes.
- **video:** `<video controls autoplay>` 90vh.
- **video_note:** `<video controls autoplay>` (audio enabled in lightbox), centered round container.
- **voice / audio / document:** no lightbox (player is inline; documents download).

`Lightbox.tsx` is a portal-rendered overlay used from both QueuePage and ChatPage.

## Edge cases

- **Failed media download** (404 from `/media/...`): MediaRenderer shows fallback chip «Не удалось загрузить медиа» + retry link.
- **Audio file with no duration metadata:** show `--:--` instead of formatted time.
- **Document without `file_name` and no extension in `mime_type`:** name = «Файл», no extension badge.
- **`send_video_note` with caption:** strip caption silently; log warning server-side.
- **Voice in iOS Safari:** Audio constructor with cross-origin `src` works only with `crossOrigin="anonymous"`. Set it on creation.
- **`/media/...` URL stripped of `?account=`:** Already handled by `withAccountQuery` — keep that.
- **Old cached messages without new fields:** MediaRenderer gracefully degrades (missing `fileSize` → empty span).

## Testing strategy

### Backend

- `tests/services/test_media_utils.py` — `video_note` returns `media_type="video_note"`, `audio` returns `"audio"`, document returns `file_size` and `mime_type`.
- `tests/routers/test_send_media.py` — happy path for each type; `video_note` with caption → caption ignored, no error.
- `tests/routers/test_messages_payload.py` — `/messages` returns `file_size` and `mime_type` for documents.

### Frontend

- MediaRenderer story-style render test for each `mediaType`.
- AttachMenu picks a `.pdf` → preview modal shows file name and size, no image preview.
- FileChip click → `download` attribute fires (jsdom).

## Test plan (manual)

1. Receive a voice message → queue card shows ▶ + waveform + duration. Click play. Same on /chat/:id.
2. Receive a video-note (кружок) → queue card shows round 240px autoplaying muted video. Click → lightbox plays with audio.
3. Receive an audio file (mp3) → AudioPlayer with title and timestamp.
4. Receive a PDF / ZIP / DOCX → FileChip shows extension badge, name, size. Click → downloads.
5. From chat, attach 📎 → AttachMenu shows Photo/Video/File. Pick a `.pdf` → preview modal → Send → file appears in chat.
6. Same for `.mp3`, `.zip`, `.docx`.
7. From queue card with media, click thumbnail → lightbox opens. ESC closes.
8. Send a 60 MB file → toast «Файл больше 50 MB не отправляется», not sent.

## Risks & mitigations

- **MediaRecorder can't produce ogg/opus on Safari:** existing `getSupportedMimeType` already falls back; voice still works.
- **Server temp file leaks:** existing `tmp_path` cleanup in `finally` is correct.
- **Browser memory bloat from many `<video preload="metadata">`:** acceptable; QueuePage shows one chat at a time, ChatPage is virtualized in Spec C.
- **Telegram-server-side compression** of photos: download endpoint returns the largest photo from the message — already correct (Pyrogram default).
