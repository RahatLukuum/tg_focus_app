# Media & Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec B — full media support: voice & video-note playback, arbitrary file upload/download, media previews on queue cards with click-to-fullscreen lightbox.

**Architecture:** Backend `media_utils` distinguishes `video_note` and `audio` (currently both collapsed). `/send_media` extends to accept `video_note`+`audio`, with optional `message_thread_id` (Spec A). Frontend gets a single `MediaRenderer` dispatcher used by both ChatPage and QueuePage, plus `AudioPlayer`, `VideoNoteView`, `FileChip`, shared `VoiceMessage`, shared `Lightbox`, and an upgraded `AttachMenu`.

**Tech Stack:** Pyrogram (`send_video_note`, `send_audio`, `send_document`), FastAPI multipart, React + TypeScript, Tailwind, lucide-react icons.

**Spec:** [docs/superpowers/specs/2026-05-08-media-and-files-design.md](../specs/2026-05-08-media-and-files-design.md)

**Depends on:** Spec A (`message_thread_id` in `/send_media` payloads).

---

## File map

**Backend — modify:**
- `backend/services/media_utils.py` — split `video_note` from `video`, add `audio`, add `file_size`/`mime_type` for documents
- `backend/routers/messages.py` — extend `/send_media` with `video_note`+`audio`, accept `message_thread_id`; `/media/...` content-type uses `mime_type` when available
- `backend/tests/test_media_utils.py` (new)
- `backend/tests/test_send_media_extended.py` (new)

**Frontend — create:**
- `frontend/src/components/media/VoiceMessage.tsx` — extracted shared
- `frontend/src/components/media/AudioPlayer.tsx`
- `frontend/src/components/media/VideoNoteView.tsx`
- `frontend/src/components/media/FileChip.tsx`
- `frontend/src/components/media/Lightbox.tsx`
- `frontend/src/components/media/MediaRenderer.tsx`
- `frontend/src/components/media/AttachMenu.tsx`
- `frontend/src/components/media/format.ts` — `formatDuration`, `formatSize`, `extensionFor`

**Frontend — modify:**
- `frontend/src/types/telegram.ts` — extend `MediaType`, add optional `fileSize` and `mimeType`
- `frontend/src/services/telegramApi.ts` — `sendMedia` accepts new types and `topicId`
- `frontend/src/pages/ChatPage.tsx` — use shared MediaRenderer, AttachMenu, Lightbox
- `frontend/src/pages/QueuePage.tsx` — same; render media on queue card

---

## Task 1: media_utils — distinguish video_note, add audio, document metadata

**Files:**
- Modify: `backend/services/media_utils.py`
- Create: `backend/tests/test_media_utils.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_media_utils.py`:

```python
"""Tests for extract_media_info covering video_note, audio, document metadata."""
from __future__ import annotations

from types import SimpleNamespace

from services.media_utils import extract_media_info


def _msg(**kw):
    base = dict(
        photo=None, video=None, voice=None, video_note=None,
        document=None, audio=None,
        chat=SimpleNamespace(id=42), id=7,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_video_note_returns_distinct_type():
    m = _msg(video_note=SimpleNamespace(duration=8))
    info = extract_media_info(m)
    assert info["media_type"] == "video_note"
    assert info["duration"] == 8


def test_audio_returns_audio_type_with_filename_and_duration():
    m = _msg(audio=SimpleNamespace(duration=180, file_name="podcast.mp3"))
    info = extract_media_info(m)
    assert info["media_type"] == "audio"
    assert info["duration"] == 180
    assert info["file_name"] == "podcast.mp3"


def test_document_returns_size_and_mime():
    m = _msg(document=SimpleNamespace(
        file_name="report.pdf", file_size=2048, mime_type="application/pdf",
    ))
    info = extract_media_info(m)
    assert info["media_type"] == "document"
    assert info["file_name"] == "report.pdf"
    assert info["file_size"] == 2048
    assert info["mime_type"] == "application/pdf"


def test_audio_takes_precedence_over_document():
    # Pyrogram exposes audio as a separate top-level attr; we check audio first.
    m = _msg(
        audio=SimpleNamespace(duration=10, file_name="a.mp3"),
        document=SimpleNamespace(file_name="x", file_size=1, mime_type="audio/mpeg"),
    )
    info = extract_media_info(m)
    assert info["media_type"] == "audio"


def test_no_media_returns_empty():
    m = _msg()
    assert extract_media_info(m) == {}


def test_chat_id_override_used_in_url():
    m = _msg(photo=SimpleNamespace())
    info = extract_media_info(m, chat_id=-100123)
    assert info["media_url"] == "/media/-100123/7"
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_media_utils.py -v
```

Expected: failures on `test_video_note_returns_distinct_type` (current code returns `"video"`), `test_audio_returns_audio_type_*` (no audio branch), `test_document_returns_size_and_mime` (no file_size/mime).

- [ ] **Step 3: Update media_utils**

Replace `backend/services/media_utils.py`:

```python
"""Media metadata extraction shared between message handler and history endpoint."""
from __future__ import annotations

from typing import Any, Optional

from pyrogram.types import Message


def extract_media_info(message: Message, *, chat_id: Optional[int] = None) -> dict[str, Any]:
    """Return media_type/media_url/file_name/duration/file_size/mime_type if present.

    Branch order: photo → video → voice → video_note → audio → document.
    `audio` is checked BEFORE `document` because Pyrogram exposes audio files
    on a dedicated `message.audio` attribute that we want to preserve.
    """
    media_type: Optional[str] = None
    file_name: Optional[str] = None
    duration: Optional[int] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None

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
        media_type = "video_note"
        duration = getattr(message.video_note, "duration", None)
    elif getattr(message, "audio", None):
        media_type = "audio"
        duration = getattr(message.audio, "duration", None)
        file_name = getattr(message.audio, "file_name", None)
        mime_type = getattr(message.audio, "mime_type", None)
        file_size = getattr(message.audio, "file_size", None)
    elif message.document:
        media_type = "document"
        file_name = getattr(message.document, "file_name", None)
        file_size = getattr(message.document, "file_size", None)
        mime_type = getattr(message.document, "mime_type", None)

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
    if file_size is not None:
        result["file_size"] = file_size
    if mime_type:
        result["mime_type"] = mime_type
    return result
```

- [ ] **Step 4: Run tests**

```
cd backend && python -m pytest tests/test_media_utils.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Run wider regression**

```
cd backend && python -m pytest tests/test_messages_since.py tests/test_incoming_handler.py -v
```

Expected: still pass. If older tests assumed `video_note → "video"`, they need updating — fix accordingly inline.

- [ ] **Step 6: Commit**

```
git add backend/services/media_utils.py backend/tests/test_media_utils.py
git commit -m "feat(media): distinguish video_note from video; add audio + doc size/mime"
```

---

## Task 2: /send_media supports video_note + audio + message_thread_id

**Files:**
- Modify: `backend/routers/messages.py`
- Create: `backend/tests/test_send_media_extended.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_send_media_extended.py`:

```python
"""Tests for /send_media: video_note, audio, message_thread_id."""
from __future__ import annotations

import io
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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


def _client_with_capture():
    captured = {"calls": []}
    client = MagicMock()
    client.me = SimpleNamespace(id=1)

    async def fake_get_me(): return client.me
    client.get_me = fake_get_me

    async def _send(name):
        async def inner(**kw):
            captured["calls"].append((name, kw))
            return SimpleNamespace(id=999)
        return inner

    async def make_send(name):
        async def inner(**kw):
            captured["calls"].append((name, kw))
            return SimpleNamespace(id=999)
        return inner

    # Bind directly:
    async def send_video_note(**kw):
        captured["calls"].append(("send_video_note", kw)); return SimpleNamespace(id=999)
    async def send_audio(**kw):
        captured["calls"].append(("send_audio", kw)); return SimpleNamespace(id=999)
    async def send_photo(**kw):
        captured["calls"].append(("send_photo", kw)); return SimpleNamespace(id=999)
    async def send_video(**kw):
        captured["calls"].append(("send_video", kw)); return SimpleNamespace(id=999)
    async def send_voice(**kw):
        captured["calls"].append(("send_voice", kw)); return SimpleNamespace(id=999)
    async def send_document(**kw):
        captured["calls"].append(("send_document", kw)); return SimpleNamespace(id=999)

    client.send_video_note = send_video_note
    client.send_audio = send_audio
    client.send_photo = send_photo
    client.send_video = send_video
    client.send_voice = send_voice
    client.send_document = send_document
    return client, captured


def _api(client):
    app = FastAPI()
    app.include_router(make_router(_Manager(client), _Auth(client)))
    return TestClient(app)


def test_send_media_video_note_strips_caption():
    client, cap = _client_with_capture()
    api = _api(client)
    r = api.post("/send_media", data={
        "chat_id": "-100123", "media_type": "video_note", "caption": "ignored",
    }, files={"file": ("clip.mp4", b"binary", "video/mp4")})
    assert r.status_code == 200
    assert cap["calls"][0][0] == "send_video_note"
    kw = cap["calls"][0][1]
    assert "caption" not in kw or kw["caption"] is None


def test_send_media_audio_passes_caption_and_filename():
    client, cap = _client_with_capture()
    api = _api(client)
    r = api.post("/send_media", data={
        "chat_id": "-100123", "media_type": "audio", "caption": "track",
    }, files={"file": ("song.mp3", b"binary", "audio/mpeg")})
    assert r.status_code == 200
    assert cap["calls"][0][0] == "send_audio"
    kw = cap["calls"][0][1]
    assert kw["caption"] == "track"


def test_send_media_passes_message_thread_id():
    client, cap = _client_with_capture()
    api = _api(client)
    r = api.post("/send_media", data={
        "chat_id": "-100123", "media_type": "photo", "caption": "",
        "message_thread_id": "7",
    }, files={"file": ("p.jpg", b"binary", "image/jpeg")})
    assert r.status_code == 200
    kw = cap["calls"][0][1]
    assert kw.get("message_thread_id") == 7
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && python -m pytest tests/test_send_media_extended.py -v
```

Expected: failures (no `video_note`/`audio` branches; no `message_thread_id`).

- [ ] **Step 3: Modify /send_media**

In `backend/routers/messages.py`, find the `api_send_media` function. Update the signature and body:

```python
@router.post("/send_media")
async def api_send_media(
    chat_id: int = Form(...),
    media_type: str = Form(...),
    account: str = Form(""),
    caption: str = Form(""),
    message_thread_id: Optional[int] = Form(None),     # NEW
    file: UploadFile = File(...),
):
    client = await auth.get_authorized_client(account)
    if not getattr(client, "me", None):
        try:
            client.me = await client.get_me()
        except Exception:
            logger.warning("get_me() failed in send_media", exc_info=True)

    suffix = Path(file.filename or "file").suffix
    if not suffix:
        suffix = (
            ".ogg" if media_type == "voice"
            else ".mp4" if media_type == "video_note"
            else ".mp3" if media_type == "audio"
            else ".bin"
        )
    CHUNK_SIZE = 1 << 20
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path: Optional[str] = None
    try:
        while True:
            chunk = await file.read(CHUNK_SIZE)
            if not chunk:
                break
            tmp.write(chunk)
        tmp.flush()
        tmp_path = tmp.name
        tmp.close()

        common: dict[str, Any] = {"chat_id": chat_id}
        if message_thread_id is not None:
            common["message_thread_id"] = int(message_thread_id)
        cap = caption or None

        if media_type == "photo":
            sent = await client.send_photo(photo=tmp_path, caption=cap, **common)
        elif media_type == "video":
            sent = await client.send_video(video=tmp_path, caption=cap, **common)
        elif media_type == "video_note":
            # Telegram: video notes don't carry captions.
            sent = await client.send_video_note(video_note=tmp_path, **common)
        elif media_type == "voice":
            sent = await client.send_voice(voice=tmp_path, caption=cap, **common)
        elif media_type == "audio":
            sent = await client.send_audio(audio=tmp_path, caption=cap, **common)
        elif media_type == "document":
            sent = await client.send_document(document=tmp_path, caption=cap, **common)
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
        logger.warning("send_media failed: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            logger.warning("failed to delete tmp file %s", tmp_path, exc_info=True)
```

Also extend the `Optional[int]` import at the top if not present.

- [ ] **Step 4: Run tests**

```
cd backend && python -m pytest tests/test_send_media_extended.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add backend/routers/messages.py backend/tests/test_send_media_extended.py
git commit -m "feat(api): /send_media supports video_note, audio, message_thread_id"
```

---

## Task 3: /media content-type uses mime_type

**Files:**
- Modify: `backend/routers/messages.py`

- [ ] **Step 1: Update content-type resolution**

In `get_media`, replace the content-type block:

```python
ct = "application/octet-stream"
if msg.photo:
    ct = "image/jpeg"
elif msg.video:
    ct = "video/mp4"
elif msg.video_note:
    ct = "video/mp4"
elif msg.voice:
    ct = "audio/ogg"
elif getattr(msg, "audio", None):
    ct = getattr(msg.audio, "mime_type", None) or "audio/mpeg"
elif msg.document:
    ct = getattr(msg.document, "mime_type", None) or "application/octet-stream"
```

- [ ] **Step 2: Smoke**

```
cd backend && python -m pytest tests/ -q
```

Expected: all pass.

- [ ] **Step 3: Commit**

```
git add backend/routers/messages.py
git commit -m "feat(api): /media uses mime_type for audio/document content-type"
```

---

## Task 4: Frontend types — extend MediaType, add fileSize/mimeType

**Files:**
- Modify: `frontend/src/types/telegram.ts`

- [ ] **Step 1: Extend types**

```typescript
export type MediaType = 'photo' | 'video' | 'voice' | 'video_note' | 'audio' | 'document';

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
  fileSize?: number;     // NEW
  mimeType?: string;     // NEW
  duration?: number;
  topicId?: number;
}
```

- [ ] **Step 2: Map new fields in telegramApi.mapMessage**

In `frontend/src/services/telegramApi.ts`, inside `mapMessage`, after the existing media branch:

```typescript
if (m.media_type) {
  msg.mediaType = m.media_type as MediaType;
  msg.mediaUrl = m.media_url ? this.baseUrl + this.withAccountQuery(m.media_url) : undefined;
  if (m.file_name) msg.fileName = m.file_name;
  if (m.duration != null) msg.duration = m.duration;
  if (m.file_size != null) msg.fileSize = m.file_size;     // NEW
  if (m.mime_type) msg.mimeType = m.mime_type;              // NEW
}
```

- [ ] **Step 3: Type-check**

```
cd frontend && npx tsc --noEmit
```

Expected: pass (existing usages of `MediaType` only use union members, so adding more is safe).

- [ ] **Step 4: Commit**

```
git add frontend/src/types/telegram.ts frontend/src/services/telegramApi.ts
git commit -m "feat(types): MediaType += video_note|audio; Message fileSize/mimeType"
```

---

## Task 5: Format helpers + Lightbox + VoiceMessage extraction

**Files:**
- Create: `frontend/src/components/media/format.ts`
- Create: `frontend/src/components/media/Lightbox.tsx`
- Create: `frontend/src/components/media/VoiceMessage.tsx`

- [ ] **Step 1: Create format helpers**

`frontend/src/components/media/format.ts`:

```typescript
export function formatDuration(s: number | undefined | null): string {
  if (s == null || !Number.isFinite(s)) return "--:--";
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function formatSize(bytes: number | undefined | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function extensionFor(fileName?: string, mimeType?: string): string {
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot > 0 && dot < fileName.length - 1) return fileName.slice(dot + 1).toUpperCase();
  }
  if (mimeType) {
    const slash = mimeType.lastIndexOf("/");
    if (slash > 0) return mimeType.slice(slash + 1).toUpperCase();
  }
  return "FILE";
}
```

- [ ] **Step 2: Create Lightbox**

`frontend/src/components/media/Lightbox.tsx`:

```tsx
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export type LightboxItem = { url: string; type: "photo" | "video" | "video_note" };

type Props = { item: LightboxItem | null; onClose: () => void };

export function Lightbox({ item, onClose }: Props) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 cursor-pointer"
      onClick={onClose}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 text-white hover:bg-white/20"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      >
        <X className="h-6 w-6" />
      </Button>
      <div className="max-w-full max-h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {item.type === "photo" && (
          <img src={item.url} alt="" className="max-w-full max-h-[90vh] object-contain" />
        )}
        {(item.type === "video" || item.type === "video_note") && (
          <video
            src={`${item.url}#t=0.001`}
            controls
            autoPlay
            playsInline
            className={
              item.type === "video_note"
                ? "max-w-full max-h-[90vh] rounded-full object-cover"
                : "max-w-full max-h-[90vh] object-contain"
            }
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Extract VoiceMessage**

`frontend/src/components/media/VoiceMessage.tsx`:

```tsx
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-react";
import { formatDuration } from "./format";

export function VoiceMessage({ url, duration }: { url: string; duration?: number }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.preload = "metadata";
    const updateProgress = () => {
      setCurrentTime(audio.currentTime);
      setProgress((audio.currentTime / (audio.duration || 1)) * 100);
    };
    const handleEnded = () => { setIsPlaying(false); setProgress(0); setCurrentTime(0); };
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("ended", handleEnded);
    return () => {
      audio.removeEventListener("timeupdate", updateProgress);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
    };
  }, [url]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const percentage = x / bounds.width;
    audioRef.current.currentTime = percentage * (audioRef.current.duration || 0);
    setProgress(percentage * 100);
  };

  return (
    <div className="flex items-center gap-3 mb-1 min-w-[200px]">
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="h-10 w-10 rounded-full shrink-0"
        onClick={togglePlay}
      >
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-1" />}
      </Button>
      <div className="flex-1 flex flex-col gap-1">
        <div
          className="h-1.5 w-full bg-primary/20 rounded-full cursor-pointer relative"
          onClick={handleSeek}
        >
          <div
            className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-75"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] opacity-70">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Smoke build**

```
cd frontend && npm run build
```

Expected: succeeds.

- [ ] **Step 5: Commit**

```
git add frontend/src/components/media/format.ts frontend/src/components/media/Lightbox.tsx frontend/src/components/media/VoiceMessage.tsx
git commit -m "feat(media): extract VoiceMessage, Lightbox, format helpers"
```

---

## Task 6: AudioPlayer + VideoNoteView + FileChip

**Files:**
- Create: `frontend/src/components/media/AudioPlayer.tsx`
- Create: `frontend/src/components/media/VideoNoteView.tsx`
- Create: `frontend/src/components/media/FileChip.tsx`

- [ ] **Step 1: AudioPlayer**

```tsx
// frontend/src/components/media/AudioPlayer.tsx
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-react";
import { formatDuration, formatSize } from "./format";

type Props = {
  url: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
};

export function AudioPlayer({ url, fileName, fileSize, duration }: Props) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.preload = "metadata";
    const tick = () => {
      setCurrentTime(audio.currentTime);
      setProgress((audio.currentTime / (audio.duration || 1)) * 100);
    };
    const ended = () => { setIsPlaying(false); setProgress(0); setCurrentTime(0); };
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("ended", ended);
    return () => {
      audio.removeEventListener("timeupdate", tick);
      audio.removeEventListener("ended", ended);
      audio.pause();
    };
  }, [url]);

  const toggle = () => {
    if (!audioRef.current) return;
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = (e.clientX - r.left) / r.width;
    audioRef.current.currentTime = p * (audioRef.current.duration || 0);
    setProgress(p * 100);
  };

  return (
    <div className="flex items-center gap-3 p-2 rounded-md bg-background/40 border border-border min-w-[240px] max-w-full">
      <Button type="button" variant="secondary" size="icon" className="h-10 w-10 rounded-full shrink-0" onClick={toggle}>
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-1" />}
      </Button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{fileName ?? "Аудио"}</p>
        <div className="h-1.5 mt-1 w-full bg-primary/20 rounded-full cursor-pointer relative" onClick={seek}>
          <div className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-75" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between text-[10px] opacity-70 mt-0.5">
          <span>{formatDuration(currentTime)}</span>
          <span>
            {formatDuration(duration)} {fileSize ? `· ${formatSize(fileSize)}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: VideoNoteView**

```tsx
// frontend/src/components/media/VideoNoteView.tsx
import React from "react";

type Props = {
  url: string;
  size?: number;  // px
  onLightbox?: () => void;
};

export function VideoNoteView({ url, size = 240, onLightbox }: Props) {
  return (
    <div className="cursor-pointer" onClick={onLightbox}>
      <video
        src={`${url}#t=0.001`}
        className="rounded-full object-cover bg-black/10"
        style={{ width: size, height: size }}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
      />
    </div>
  );
}
```

- [ ] **Step 3: FileChip**

```tsx
// frontend/src/components/media/FileChip.tsx
import React from "react";
import { Download } from "lucide-react";
import { extensionFor, formatSize } from "./format";

type Props = {
  url: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
};

export function FileChip({ url, fileName, fileSize, mimeType }: Props) {
  const ext = extensionFor(fileName, mimeType);
  return (
    <a
      href={url}
      download={fileName ?? "file"}
      className="flex items-center gap-3 p-3 bg-background/50 rounded-lg border border-border hover:bg-background/80 transition-colors mb-1 max-w-full"
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="h-10 w-10 shrink-0 rounded bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">
        {ext.slice(0, 4)}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium truncate">{fileName ?? "Файл"}</span>
        {fileSize ? (
          <span className="text-xs text-muted-foreground">{formatSize(fileSize)}</span>
        ) : null}
      </div>
      <Download className="ml-auto h-4 w-4 opacity-60 shrink-0" />
    </a>
  );
}
```

- [ ] **Step 4: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 5: Commit**

```
git add frontend/src/components/media/AudioPlayer.tsx frontend/src/components/media/VideoNoteView.tsx frontend/src/components/media/FileChip.tsx
git commit -m "feat(media): AudioPlayer, VideoNoteView, FileChip components"
```

---

## Task 7: MediaRenderer dispatcher

**Files:**
- Create: `frontend/src/components/media/MediaRenderer.tsx`

- [ ] **Step 1: MediaRenderer**

```tsx
// frontend/src/components/media/MediaRenderer.tsx
import React from "react";
import { AudioPlayer } from "./AudioPlayer";
import { FileChip } from "./FileChip";
import type { LightboxItem } from "./Lightbox";
import { VideoNoteView } from "./VideoNoteView";
import { VoiceMessage } from "./VoiceMessage";
import type { MediaType } from "@/types/telegram";

type Props = {
  mediaType: MediaType;
  mediaUrl: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  onLightbox?: (item: LightboxItem) => void;
};

export function MediaRenderer({
  mediaType, mediaUrl, fileName, fileSize, mimeType, duration, onLightbox,
}: Props) {
  switch (mediaType) {
    case "photo":
      return (
        <img
          src={mediaUrl}
          alt=""
          loading="lazy"
          className="max-w-full max-h-64 rounded-md mb-1 cursor-pointer object-cover"
          onClick={() => onLightbox?.({ url: mediaUrl, type: "photo" })}
        />
      );
    case "video":
      return (
        <video
          src={`${mediaUrl}#t=0.001`}
          controls
          playsInline
          preload="metadata"
          className="max-w-full max-h-64 rounded-md mb-1 bg-black/10 cursor-pointer"
          onClick={(e) => { e.preventDefault(); onLightbox?.({ url: mediaUrl, type: "video" }); }}
        />
      );
    case "video_note":
      return (
        <VideoNoteView url={mediaUrl} onLightbox={() => onLightbox?.({ url: mediaUrl, type: "video_note" })} />
      );
    case "voice":
      return <VoiceMessage url={mediaUrl} duration={duration} />;
    case "audio":
      return <AudioPlayer url={mediaUrl} fileName={fileName} fileSize={fileSize} duration={duration} />;
    case "document":
    default:
      return <FileChip url={mediaUrl} fileName={fileName} fileSize={fileSize} mimeType={mimeType} />;
  }
}
```

- [ ] **Step 2: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```
git add frontend/src/components/media/MediaRenderer.tsx
git commit -m "feat(media): MediaRenderer dispatcher"
```

---

## Task 8: AttachMenu (3 buttons)

**Files:**
- Create: `frontend/src/components/media/AttachMenu.tsx`

- [ ] **Step 1: AttachMenu**

```tsx
// frontend/src/components/media/AttachMenu.tsx
import React from "react";
import { Button } from "@/components/ui/button";
import { Image, Video, FileText } from "lucide-react";

type Props = {
  onPickPhoto: () => void;
  onPickVideo: () => void;
  onPickFile: () => void;
};

export function AttachMenu({ onPickPhoto, onPickVideo, onPickFile }: Props) {
  return (
    <div className="absolute bottom-full mb-2 left-4 z-30 bg-popover border border-border rounded-lg shadow-lg p-2 flex gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onPickPhoto}>
        <Image className="h-4 w-4 mr-1" /> Фото
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onPickVideo}>
        <Video className="h-4 w-4 mr-1" /> Видео
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onPickFile}>
        <FileText className="h-4 w-4 mr-1" /> Файл
      </Button>
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
git add frontend/src/components/media/AttachMenu.tsx
git commit -m "feat(media): AttachMenu with photo/video/file options"
```

---

## Task 9: telegramApi.sendMedia accepts new types + topicId

**Files:**
- Modify: `frontend/src/services/telegramApi.ts`

- [ ] **Step 1: Update sendMedia signature**

```typescript
async sendMedia(
  chatId: number,
  file: Blob,
  mediaType: MediaType,
  caption?: string,
  topicId?: number,
): Promise<Message> {
  if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('media_type', mediaType);
  form.append('caption', caption || '');
  if (this.activeAccount) form.append('account', this.activeAccount);
  if (topicId !== undefined) form.append('message_thread_id', String(topicId));

  const fileType = file.type || '';
  const ext =
    mediaType === 'photo' ? '.jpg' :
    mediaType === 'video' ? '.mp4' :
    mediaType === 'video_note' ? '.mp4' :
    mediaType === 'voice' ? '.ogg' :
    mediaType === 'audio' ? '.mp3' :
    '.bin';
  // Preserve original filename when caller provides a File (has .name).
  const inferredName = (file as any).name && typeof (file as any).name === "string"
    ? (file as any).name
    : `upload${ext}`;
  form.append('file', file, inferredName);

  const url = this.baseUrl + this.withAccountQuery('/send_media');
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || 'Upload failed');
  }
  const data = await res.json().catch(() => ({}));
  const messageId = data.message_id || Date.now();
  const mediaPath = `/media/${chatId}/${messageId}`;

  let senderId = 0;
  try { senderId = (await this.getCurrentUser()).id; } catch { /* ignore */ }

  return {
    id: messageId,
    chatId,
    senderId,
    text: caption || '',
    date: new Date(),
    isOutgoing: true,
    mediaType,
    mediaUrl: this.baseUrl + this.withAccountQuery(mediaPath),
    fileName: (file as any).name ?? undefined,
    fileSize: file.size ?? undefined,
    mimeType: file.type || undefined,
    topicId,
  };
}
```

- [ ] **Step 2: Update TelegramContext.sendMedia signature**

In `frontend/src/contexts/TelegramContext.tsx`, find the `sendMedia` interface entry and the implementation. Update to accept `topicId?: number` as 5th arg, forward to `telegramApi.sendMedia(...)`.

- [ ] **Step 3: Type-check + build**

```
cd frontend && npx tsc --noEmit && npm run build
```

Expected: pass.

- [ ] **Step 4: Commit**

```
git add frontend/src/services/telegramApi.ts frontend/src/contexts/TelegramContext.tsx
git commit -m "feat(api-client): sendMedia supports video_note/audio + topicId"
```

---

## Task 10: ChatPage uses MediaRenderer + AttachMenu + Lightbox

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`

- [ ] **Step 1: Replace local renderMedia and VoiceMessage**

Delete the local `VoiceMessage` definition (lines ~9-89) and the local `renderMedia` function (lines ~423-440). Add imports at the top:

```tsx
import { MediaRenderer } from "@/components/media/MediaRenderer";
import { Lightbox, type LightboxItem } from "@/components/media/Lightbox";
import { AttachMenu } from "@/components/media/AttachMenu";
```

- [ ] **Step 2: Replace fullscreenMedia state shape**

Change:
```tsx
const [fullscreenMedia, setFullscreenMedia] = useState<{url: string, type: MediaType} | null>(null);
```
to:
```tsx
const [lightboxItem, setLightboxItem] = useState<LightboxItem | null>(null);
```

- [ ] **Step 3: Use MediaRenderer in the message map**

Find the message render block (`messages.map((msg) => ...`):

```tsx
{messages.map((msg) => (
  <div key={msg.id} className={`flex ${msg.isOutgoing ? "justify-end" : "justify-start"}`}>
    <div className={[
      "px-4 py-2 rounded-2xl",
      "max-w-[85%] sm:max-w-[70%] md:max-w-[60%]",
      "break-words [overflow-wrap:anywhere]",
      msg.isOutgoing ? "bg-primary text-primary-foreground" : "bg-muted",
    ].join(" ")}>
      {msg.senderName && (
        <p className="text-xs font-semibold text-blue-500 mb-0.5">{msg.senderName}</p>
      )}
      {msg.mediaType && msg.mediaUrl && (
        <MediaRenderer
          mediaType={msg.mediaType}
          mediaUrl={msg.mediaUrl}
          fileName={(msg as any).fileName}
          fileSize={(msg as any).fileSize}
          mimeType={(msg as any).mimeType}
          duration={msg.duration}
          onLightbox={(item) => setLightboxItem(item)}
        />
      )}
      {msg.text && <p className="text-sm whitespace-pre-wrap">{msg.text}</p>}
      <p className={`text-[11px] mt-1 ${msg.isOutgoing ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
        {msg.time}
      </p>
    </div>
  </div>
))}
```

> Bubble width/wrapping is the structural contract for Spec C — leave it here as well; deduplicating into a separate `MessageBubble` component happens in Plan C.

- [ ] **Step 4: Replace AttachMenu**

In the input bar, find the `{showAttach && ( ... <Image><Video> ... )}` block. Replace with:

```tsx
{showAttach && (
  <AttachMenu
    onPickPhoto={() => imageInputRef.current?.click()}
    onPickVideo={() => videoInputRef.current?.click()}
    onPickFile={() => fileInputRef.current?.click()}
  />
)}
```

Add a third hidden input next to the existing image/video ones:

```tsx
<input ref={fileInputRef} type="file" className="hidden" onChange={(e) => handleFileChange(e, "document")} />
```

Declare `const fileInputRef = useRef<HTMLInputElement | null>(null);` near the other refs.

- [ ] **Step 5: Replace Fullscreen Viewer**

Replace the existing `{fullscreenMedia && ( ... )}` block at the bottom with:

```tsx
<Lightbox item={lightboxItem} onClose={() => setLightboxItem(null)} />
```

- [ ] **Step 6: Update preview modal to handle non-image types**

In the existing `{previewFile && ...}` modal, gate the preview content on type:

```tsx
{(previewType === "photo" || previewType === "video") ? (
  <div className="flex justify-center max-h-64 overflow-hidden rounded-lg bg-muted">
    {previewType === "photo" && previewUrl && <img src={previewUrl} alt="" className="max-h-64 object-contain" />}
    {previewType === "video" && previewUrl && <video src={previewUrl} controls className="max-h-64 object-contain" />}
  </div>
) : (
  <div className="p-3 rounded-md bg-muted text-sm break-words">
    <p className="font-medium">{previewFile.name}</p>
    <p className="text-xs text-muted-foreground">
      {(previewFile.size / 1024 / 1024).toFixed(2)} MB
    </p>
  </div>
)}
```

Update the modal title to be generic: «Отправить файл» when `previewType === "document"`, otherwise the existing photo/video labels.

- [ ] **Step 7: Add 50MB guard**

In `handleFileChange` and the picker flow, add:

```tsx
const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: MediaType) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    toast.error("Файл больше 50 MB не отправляется");
    e.target.value = "";
    return;
  }
  openPreview(file, type);
  e.target.value = "";
};
```

- [ ] **Step 8: Smoke build**

```
cd frontend && npm run build
```

Expected: build passes.

- [ ] **Step 9: Commit**

```
git add frontend/src/pages/ChatPage.tsx
git commit -m "feat(chat): use shared MediaRenderer/Lightbox/AttachMenu; arbitrary file send"
```

---

## Task 11: QueuePage card uses MediaRenderer + Lightbox + AttachMenu

**Files:**
- Modify: `frontend/src/pages/QueuePage.tsx`

- [ ] **Step 1: Drop local VoiceMessage and renderMedia**

Same as Task 10 step 1 — remove local copies, import shared components:

```tsx
import { MediaRenderer } from "@/components/media/MediaRenderer";
import { Lightbox, type LightboxItem } from "@/components/media/Lightbox";
import { AttachMenu } from "@/components/media/AttachMenu";
```

Replace `fullscreenMedia` state with `lightboxItem`.

- [ ] **Step 2: Render media on the current-message bubble**

In the «Current Message» bubble (the one updated in Plan A Task 16), enrich:

```tsx
{(() => {
  const lastMsg = state.messages[currentChatId]?.at(-1);
  const queueMeta = state.queueMeta?.[currentChatId];
  const topicTitle = queueMeta?.topic_title ?? null;
  return (
    <div className="bg-muted p-4 rounded-lg space-y-2">
      {topicTitle && (
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground"># {topicTitle}</p>
      )}
      {isGroupChat && lastMsg?.senderName && (
        <p className="text-xs font-semibold text-blue-500">{lastMsg.senderName}</p>
      )}
      {lastMsg?.mediaType && lastMsg.mediaUrl && (
        <MediaRenderer
          mediaType={lastMsg.mediaType}
          mediaUrl={lastMsg.mediaUrl}
          fileName={lastMsg.fileName}
          fileSize={(lastMsg as any).fileSize}
          mimeType={(lastMsg as any).mimeType}
          duration={lastMsg.duration}
          onLightbox={(item) => setLightboxItem(item)}
        />
      )}
      {lastMsg?.text && <p className="text-sm whitespace-pre-wrap break-words">{lastMsg.text}</p>}
      <p className="text-xs text-muted-foreground">{lastMsg?.time ?? currentDialog.time}</p>
    </div>
  );
})()}
```

- [ ] **Step 3: Use shared MediaRenderer in history list**

In the `history.slice(0, -1).map((message) => ...)` block, replace inline media render with `<MediaRenderer ... />`.

- [ ] **Step 4: Use AttachMenu and add file picker**

Replace the local `{showAttach && ( ... <Image><Video> ... )}` block with `<AttachMenu ... />` (mirror Task 10 Step 4). Add `fileInputRef` and matching hidden `<input type="file">` with `accept="*/*"`.

- [ ] **Step 5: Use shared Lightbox**

Replace the existing `{fullscreenMedia && ( ... )}` block with:

```tsx
<Lightbox item={lightboxItem} onClose={() => setLightboxItem(null)} />
```

- [ ] **Step 6: Add 50MB guard (same as Task 10 step 7)**

- [ ] **Step 7: Smoke build**

```
cd frontend && npm run build
```

- [ ] **Step 8: Commit**

```
git add frontend/src/pages/QueuePage.tsx
git commit -m "feat(queue): media on card; shared MediaRenderer/Lightbox/AttachMenu"
```

---

## Task 12: Final validation

**Files:** none

- [ ] **Step 1: Backend tests**

```
cd backend && python -m pytest -q
```

- [ ] **Step 2: Frontend lint + build**

```
cd frontend && npm run lint && npm run build
```

- [ ] **Step 3: Manual sanity walk**

1. Receive a voice message → ▶ on queue card and inside chat.
2. Receive a video-note → 240px round autoplay-muted on queue card; click → lightbox plays with audio.
3. Receive `.mp3` → AudioPlayer with seek; in queue card too.
4. Receive `.pdf` / `.zip` → FileChip with extension badge + size; click downloads.
5. From AttachMenu, send a `.pdf`. It appears in chat as FileChip.
6. Send a 60 MB file → toast «Файл больше 50 MB не отправляется».
7. Click any photo/video → Lightbox; ESC closes; click outside closes.

- [ ] **Step 4: Final commit if anything dangling**

```
git status
git diff --stat
```

---

## Self-review

- **Spec coverage:**
  - п.2 (voice + video-note plays on queue card and chat) → Tasks 5, 6, 7, 10, 11 ✓
  - п.7 (arbitrary file upload + display + download) → Tasks 1, 2, 6 (FileChip), 8 (AttachMenu), 9, 10, 11 ✓
  - п.8 (media preview on queue card with lightbox) → Tasks 7, 11 + shared Lightbox ✓
- **Type consistency:**
  - `MediaType` extension `'video_note' | 'audio'` is added in Task 4 before any consumer (Tasks 5+) uses it ✓
  - `MediaRenderer` props match all consumers; `LightboxItem` exported from Lightbox.tsx and consumed by both pages ✓
  - `sendMedia(...., topicId?)` 5th arg matches Plan A's `topicId` propagation pattern ✓
- **Placeholders:** none. All steps contain full code or exact commands.

---

## Execution

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
