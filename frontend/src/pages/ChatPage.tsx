import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Send, Paperclip, Mic, Image, Video, Sparkles, X, Play, Pause } from 'lucide-react';
import { toast } from 'sonner';

const VoiceMessage = ({ url, duration }: { url: string; duration?: number }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.preload = 'metadata';

    const updateProgress = () => {
      setCurrentTime(audio.currentTime);
      setProgress((audio.currentTime / (audio.duration || 1)) * 100);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    };

    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('ended', handleEnded);
      audio.pause();
    };
  }, [url]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const percentage = x / bounds.width;
    const newTime = percentage * (audioRef.current.duration || 0);
    audioRef.current.currentTime = newTime;
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
          <span>{duration != null ? formatDuration(duration) : ''}</span>
        </div>
      </div>
    </div>
  );
};
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import { getCached, setCached, appendCached } from "@/services/messageCache";
import { MediaType } from '@/types/telegram';

type UiMsg = {
  id: number;
  text: string;
  isOutgoing: boolean;
  time: string;
  senderName?: string;
  mediaType?: MediaType;
  mediaUrl?: string;
  duration?: number;
};

const formatDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

function getSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  for (const mt of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mt)) return mt;
    } catch { /* ignore */ }
  }
  return undefined;
}

const ChatPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { chatId } = useParams();
  const [message, setMessage] = useState('');
  const { state, loadMessages, loadOlderMessages, sendMessage, sendMedia, dispatch } = useTelegram();
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevMsgCountRef = useRef(0);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const shouldSendRecordingRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const initialScrollDoneRef = useRef(false);

  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewType, setPreviewType] = useState<MediaType>('photo');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewCaption, setPreviewCaption] = useState('');
  const [isSendingMedia, setIsSendingMedia] = useState(false);

  const numericChatId = parseInt(chatId || '0', 10);
  const shouldPreloadFull = !!(location.state as any)?.preloadFull;
  const contact = state.chats.find(c => c.id === numericChatId) || state.contacts?.find(c => c.id === numericChatId);
  const [remoteChatTitle, setRemoteChatTitle] = useState<string | null>(null);
  const chatTitle = contact?.title || remoteChatTitle || 'Загрузка...';

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
    }, 50);
  }, []);

  const preloadFullChatHistory = useCallback(async (targetChatId: number) => {
    const pageSize = 100;
    const maxPages = 30;
    const firstBatch = await telegramApi.getMessages(targetChatId, pageSize);
    let allMessages = [...firstBatch];
    let beforeId = firstBatch[0]?.id;
    let pagesLoaded = 0;
    while (beforeId && pagesLoaded < maxPages) {
      const older = await telegramApi.getOlderMessages(targetChatId, beforeId, pageSize);
      if (!older.length) break;
      allMessages = [...older, ...allMessages];
      beforeId = older[0]?.id;
      pagesLoaded += 1;
    }
    dispatch({ type: 'SET_MESSAGES', payload: { chatId: targetChatId, messages: allMessages } });
  }, [dispatch]);

  useEffect(() => {
    if (!state.isInitialized) return;
    let cancelled = false;

    initialScrollDoneRef.current = false;
    prevMsgCountRef.current = 0;

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
        scrollToBottom();
      }

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
          scrollToBottom();
        } catch (e) {
          console.warn("delta sync failed:", e);
        }
      } else {
        // No cache — fetch directly so we have a non-stale reference for caching.
        try {
          const fresh = await telegramApi.getMessages(numericChatId);
          if (cancelled) return;
          dispatch({
            type: "SET_MESSAGES",
            payload: { chatId: numericChatId, messages: fresh },
          });
          if (fresh.length > 0) {
            await setCached(numericChatId, fresh);
          }
          if (shouldPreloadFull) {
            // preloadFullChatHistory paginates older messages too — keep it
            // for full preload when explicitly requested.
            await preloadFullChatHistory(numericChatId);
          }
        } catch (e) {
          console.warn("ChatPage initial load failed:", e);
        }
        if (cancelled) return;
        scrollToBottom();
      }
    };

    run();

    if (!contact) {
      telegramApi.getChatInfo(numericChatId).then(info => {
        setRemoteChatTitle(info.title);
      }).catch(() => {});
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericChatId, shouldPreloadFull, state.isInitialized]);

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

  const isGroup = contact?.type === 'group' || contact?.type === 'supergroup';

  const messages = useMemo<UiMsg[]>(() => {
    const list = state.messages[numericChatId] || [];
    return list.map(m => ({
      id: m.id,
      text: m.text,
      isOutgoing: m.isOutgoing,
      time: new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      senderName: isGroup && !m.isOutgoing ? m.senderName : undefined,
      mediaType: m.mediaType,
      mediaUrl: m.mediaUrl,
      duration: m.duration,
    }));
  }, [state.messages, numericChatId, isGroup]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || messages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      scrollToBottom();
      setTimeout(scrollToBottom, 200);
      return;
    }
    const isNewMessage = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (isNewMessage || el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !numericChatId) return;
    await sendMessage(numericChatId, message.trim());
    setMessage('');
  };

  const openPreview = (file: File, type: MediaType) => {
    setPreviewFile(file);
    setPreviewType(type);
    setPreviewCaption('');
    if (type === 'photo' || type === 'video') {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }
    setShowAttach(false);
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewFile(null);
    setPreviewUrl(null);
    setPreviewCaption('');
  };

  const sendPreview = async () => {
    if (!previewFile || !numericChatId || isSendingMedia) return;
    setIsSendingMedia(true);
    try {
      const caption = previewCaption.trim() || undefined;
      await sendMedia(numericChatId, previewFile, previewType, caption);
      closePreview();
    } catch (err: any) {
      console.error('Media send error:', err);
      toast.error(err.message || 'Ошибка отправки медиа');
    } finally {
      setIsSendingMedia(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: MediaType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    openPreview(file, type);
    e.target.value = '';
  };

  const stopRecording = useCallback((shouldSend: boolean) => {
    shouldSendRecordingRef.current = shouldSend;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const startRecording = useCallback(async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      console.error('MediaRecorder or getUserMedia not available');
      toast.error('Запись аудио недоступна в этом браузере или требуется HTTPS');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      shouldSendRecordingRef.current = true;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (shouldSendRecordingRef.current && chunksRef.current.length > 0 && numericChatId) {
          const recordedType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/ogg';
          const blob = new Blob(chunksRef.current, { type: recordedType });
          await sendMedia(numericChatId, blob, 'voice');
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch (err: any) {
      console.error('Microphone access denied', err);
      toast.error('Ошибка доступа к микрофону: ' + (err.message || 'Разрешите доступ в браузере'));
    }
  }, [numericChatId, sendMedia]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          shouldSendRecordingRef.current = false;
          mediaRecorderRef.current.stop();
        } catch {}
      }
    };
  }, []);

  const handleGenerateReply = async () => {
    if (!numericChatId || isGenerating) return;
    setIsGenerating(true);
    try {
      const res = await telegramApi.generateReply(numericChatId);
      if (res) setMessage(res);
    } catch (err) {
      console.error('AI generation error:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const [fullscreenMedia, setFullscreenMedia] = useState<{url: string, type: MediaType} | null>(null);

  const renderMedia = (msg: UiMsg) => {
    if (!msg.mediaType || !msg.mediaUrl) return null;
    switch (msg.mediaType) {
      case 'photo':
        return <img src={msg.mediaUrl} alt="" className="max-w-full max-h-64 rounded-md mb-1 cursor-pointer object-cover" loading="lazy" onClick={() => setFullscreenMedia({url: msg.mediaUrl!, type: 'photo'})} />;
      case 'video':
        return <video src={`${msg.mediaUrl}#t=0.001`} controls playsInline className="max-w-full max-h-64 rounded-md mb-1 bg-black/10 cursor-pointer" preload="metadata" onClick={(e) => { e.preventDefault(); setFullscreenMedia({url: msg.mediaUrl!, type: 'video'}); }} />;
      case 'voice':
        return <VoiceMessage url={msg.mediaUrl} duration={msg.duration} />;
      default:
        return (
          <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-2 bg-background/50 rounded-md border border-border hover:bg-background/80 transition-colors mb-1 max-w-full">
            <Paperclip className="h-4 w-4 shrink-0" />
            <span className="text-sm truncate">{msg.fileName || 'Скачать файл'}</span>
          </a>
        );
    }
  };

  if (!state.isInitialized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Восстановление сессии...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/message')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback>{chatTitle[0] || 'U'}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">{chatTitle}</h1>
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 pb-24 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                msg.isOutgoing
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted'
              }`}
            >
              {msg.senderName && (
                <p className="text-xs font-semibold text-blue-500 mb-0.5">{msg.senderName}</p>
              )}
              {renderMedia(msg)}
              {msg.text && <p className="text-sm">{msg.text}</p>}
              <p className={`text-xs mt-1 ${
                msg.isOutgoing ? 'text-primary-foreground/70' : 'text-muted-foreground'
              }`}>
                {msg.time}
              </p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Media Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={closePreview}>
          <div className="bg-background rounded-xl shadow-2xl max-w-md w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">
                {previewType === 'photo' ? 'Отправить фото' : 'Отправить видео'}
              </h3>
              <Button variant="ghost" size="icon" onClick={closePreview}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex justify-center max-h-64 overflow-hidden rounded-lg bg-muted">
              {previewType === 'photo' && previewUrl && (
                <img src={previewUrl} alt="Preview" className="max-h-64 object-contain" />
              )}
              {previewType === 'video' && previewUrl && (
                <video src={previewUrl} controls className="max-h-64 object-contain" />
              )}
            </div>
            <Input
              value={previewCaption}
              onChange={e => setPreviewCaption(e.target.value)}
              placeholder="Подпись (необязательно)"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendPreview(); } }}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={closePreview} disabled={isSendingMedia}>Отмена</Button>
              <Button type="button" onClick={sendPreview} disabled={isSendingMedia}>
                <Send className="h-4 w-4 mr-1" />
                {isSendingMedia ? 'Отправка...' : 'Отправить'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Message Input */}
      <div className="sticky bottom-0 z-10 bg-background border-t border-border p-4 relative">
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFileChange(e, 'photo')} />
        <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={(e) => handleFileChange(e, 'video')} />
        {showAttach && (
          <div className="absolute bottom-full mb-2 left-4 z-30 bg-popover border border-border rounded-lg shadow-lg p-2 flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => imageInputRef.current?.click()}>
              <Image className="h-4 w-4 mr-1" />
              Фото
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => videoInputRef.current?.click()}>
              <Video className="h-4 w-4 mr-1" />
              Видео
            </Button>
          </div>
        )}
        {isRecording ? (
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-2">
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-red-500" onClick={() => stopRecording(false)}>
              <X className="h-4 w-4" />
            </Button>
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
              <span className="text-sm text-muted-foreground truncate">Запись голосового...</span>
              <span className="text-sm font-medium ml-auto">{formatDuration(recordingTime)}</span>
            </div>
            <Button type="button" size="icon" className="h-8 w-8 rounded-full" onClick={() => stopRecording(true)}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSendMessage} className="flex gap-2 items-center">
            <Button type="button" variant="ghost" size="icon" onClick={() => setShowAttach(!showAttach)}>
              <Paperclip className="h-4 w-4" />
            </Button>
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Введите сообщение..."
              className="flex-1"
              autoFocus
              onFocus={() => setShowAttach(false)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleGenerateReply}
              disabled={isGenerating}
              title="Сгенерировать ответ с помощью AI"
            >
              <Sparkles className={`h-4 w-4 ${isGenerating ? 'animate-spin' : ''}`} />
            </Button>
            {message.trim() ? (
              <Button type="submit" size="icon">
                <Send className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="button" size="icon" variant="secondary" onClick={startRecording}>
                <Mic className="h-4 w-4" />
              </Button>
            )}
          </form>
        )}
      </div>

      {/* Fullscreen Media Viewer */}
      {fullscreenMedia && (
        <div 
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setFullscreenMedia(null)}
        >
          <Button 
            variant="ghost" 
            size="icon" 
            className="absolute top-4 right-4 text-white hover:bg-white/20"
            onClick={(e) => { e.stopPropagation(); setFullscreenMedia(null); }}
          >
            <X className="h-6 w-6" />
          </Button>
          <div className="max-w-full max-h-full flex items-center justify-center" onClick={e => e.stopPropagation()}>
            {fullscreenMedia.type === 'photo' && (
              <img src={fullscreenMedia.url} alt="Fullscreen" className="max-w-full max-h-[90vh] object-contain" />
            )}
            {fullscreenMedia.type === 'video' && (
              <video src={`${fullscreenMedia.url}#t=0.001`} controls autoPlay playsInline className="max-w-full max-h-[90vh] object-contain" />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatPage;
