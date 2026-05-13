import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, MessageCircle, Send, Paperclip, Mic, ExternalLink, X, Folder } from 'lucide-react';
import { toast } from 'sonner';
import { MediaRenderer } from '@/components/media/MediaRenderer';
import { Lightbox, type LightboxItem } from '@/components/media/Lightbox';
import { AttachMenu } from '@/components/media/AttachMenu';

const formatDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

import { Input } from '@/components/ui/input';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import { useFolders } from '@/hooks/useFolders';
import { usePrefetchQueue } from '@/hooks/usePrefetchQueue';
import { QueueFilter, type QueueFilterState } from '@/components/queue/QueueFilter';
import { QueueActionsBar } from '@/components/queue/QueueActionsBar';
import { getCached, setCached } from '@/services/messageCache';
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
  fileName?: string;
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

const QueuePage = () => {
  const navigate = useNavigate();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [queueIds, setQueueIds] = useState<number[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [newMessages, setNewMessages] = useState<Record<number, Array<{
    id: number;
    text: string;
    isOutgoing: boolean;
    time: string;
  }>>>({});
  const { state, loadMessages, loadOlderMessages, sendMessage, sendMedia, loadChats, dispatch } = useTelegram();
  const { folders, chatToFolders } = useFolders();
  const [filter, setFilter] = useState<QueueFilterState>({ types: [], folderIds: [] });
  const historyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const shouldSendRecordingRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewType, setPreviewType] = useState<MediaType>('photo');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewCaption, setPreviewCaption] = useState('');
  const [isSendingMedia, setIsSendingMedia] = useState(false);

  useEffect(() => {
    telegramApi.getBootstrap()
      .then((bootstrap) => {
        setQueueIds(bootstrap.queue);
        dispatch({ type: 'SET_CHATS', payload: bootstrap.chats });
        dispatch({ type: 'SET_CONTACTS', payload: bootstrap.contacts });
      })
      .catch(() => {
        fetchQueue();
        if (!state.chats || state.chats.length === 0) {
          loadChats().catch(() => {});
        }
      });
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch {}
      }
    };
  }, []);

  const fetchQueue = async () => {
    try {
      const items = await telegramApi.getQueueMeta();
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
      dispatch({ type: 'SET_QUEUE_META', payload: metaMap });
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (state.queueRevision === 0) return;
    fetchQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.queueRevision]);

  const visibleQueueIds = useMemo(() => {
    return queueIds.filter((cid) => {
      const chat = state.chats.find(c => c.id === cid);
      if (filter.types.length > 0) {
        const isPrivate = chat?.type === 'private';
        const isGroupChat = chat?.type === 'group' || chat?.type === 'supergroup';
        const matchesType =
          (filter.types.includes('private') && isPrivate) ||
          (filter.types.includes('groups') && isGroupChat);
        if (!matchesType) return false;
      }
      if (filter.folderIds.length > 0) {
        const chatFolders = chatToFolders.get(cid) ?? [];
        if (!chatFolders.some(id => filter.folderIds.includes(id))) return false;
      }
      return true;
    });
  }, [queueIds, filter, chatToFolders, state.chats]);

  const currentChatId = visibleQueueIds[currentIndex];
  const currentChat = state.chats.find(c => c.id === currentChatId) || state.contacts?.find(c => c.id === currentChatId);
  const [chatTitles, setChatTitles] = useState<Record<number, string>>({});

  // Prefetch the next 1-2 chats in the queue.
  usePrefetchQueue(visibleQueueIds, currentIndex);

  useEffect(() => {
    if (!currentChatId) return;
    let cancelled = false;

    const run = async () => {
      // 1. Hydrate from cache instantly.
      const cached = await getCached(currentChatId);
      if (cancelled) return;
      if (cached && cached.messages.length > 0) {
        dispatch({
          type: "SET_MESSAGES",
          payload: { chatId: currentChatId, messages: cached.messages },
        });
      }

      // 2. Fetch fresh — direct call so we have a non-stale reference to cache.
      try {
        const fresh = await telegramApi.getMessages(currentChatId);
        if (cancelled) return;
        dispatch({
          type: "SET_MESSAGES",
          payload: { chatId: currentChatId, messages: fresh },
        });
        if (fresh.length > 0) {
          await setCached(currentChatId, fresh);
        }
      } catch {
        // network failure — keep showing cache
      }
    };

    run();

    if (!currentChat && !chatTitles[currentChatId]) {
      telegramApi
        .getChatInfo(currentChatId)
        .then((info) => {
          setChatTitles((prev) => ({ ...prev, [currentChatId]: info.title }));
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId]);

  const isGroupChat = currentChat?.type === 'group' || currentChat?.type === 'supergroup';

  const history: UiMsg[] = useMemo(() => {
    const list = state.messages[currentChatId] || [];
    return list.map(m => ({
      id: m.id,
      text: m.text,
      isOutgoing: m.isOutgoing,
      time: new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      senderName: isGroupChat && !m.isOutgoing ? m.senderName : undefined,
      mediaType: m.mediaType,
      mediaUrl: m.mediaUrl,
      duration: m.duration,
      fileName: m.fileName,
    }));
  }, [state.messages, currentChatId, isGroupChat]);

  const [lightboxItem, setLightboxItem] = useState<LightboxItem | null>(null);

  const currentDialog = currentChatId ? {
    id: currentChatId,
    name: currentChat?.title || chatTitles[currentChatId] || `Чат ${currentChatId}`,
    lastMessage: history.at(-1)?.text || '',
    time: history.at(-1)?.time || '',
  } : undefined as any;

  const currentFolderLabel = useMemo(() => {
    if (!currentChatId) return "";
    const ids = chatToFolders.get(currentChatId) || [];
    if (ids.length === 0) return "";
    const titles = ids
      .map((id) => folders.find((f) => f.id === id)?.title)
      .filter((t): t is string => !!t);
    return titles.join(" · ");
  }, [currentChatId, chatToFolders, folders]);

  const handleDone = async () => {
    if (!currentChatId) return;
    try {
      await telegramApi.queueAction(currentChatId, 'done');
      setQueueIds((prev) => {
        const next = prev.filter((id) => id !== currentChatId);
        setCurrentIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
        return next;
      });
      dispatch({ type: 'QUEUE_DIRTY' });
    } catch (e) {
      console.warn('done failed', e);
    }
  };

  const handleSnooze = async (untilTs: number) => {
    if (!currentChatId) return;
    try {
      await telegramApi.queueAction(currentChatId, 'snooze', { snooze_until: untilTs });
      setQueueIds((prev) => {
        const next = prev.filter((id) => id !== currentChatId);
        setCurrentIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
        return next;
      });
      dispatch({ type: 'QUEUE_DIRTY' });
    } catch (e) {
      console.warn('snooze failed', e);
    }
  };

  const handleSkip = async () => {
    if (!currentChatId) return;
    try {
      const newQueue = await telegramApi.queueAction(currentChatId, 'skip');
      setQueueIds(newQueue);
      setCurrentIndex((i) => Math.min(i, Math.max(0, newQueue.length - 1)));
      dispatch({ type: 'QUEUE_DIRTY' });
    } catch (e) {
      console.warn('skip failed', e);
    }
  };

  const handleTaskCreated = async (alsoRemove: boolean) => {
    if (alsoRemove) {
      await handleDone();
    }
  };

  const handleArchive = async () => {
    if (!currentChatId) return;
    try {
      await telegramApi.archiveChat(currentChatId);
      dispatch({
        type: 'SET_CHAT_ARCHIVED',
        payload: { chatId: currentChatId, archived: true },
      });
      setQueueIds((prev) => {
        const next = prev.filter((id) => id !== currentChatId);
        setCurrentIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
        return next;
      });
      dispatch({ type: 'QUEUE_DIRTY' });
      toast.success('Чат в архиве');
    } catch (e: any) {
      console.warn('archive failed', e);
      toast.error(e?.message || 'Не удалось архивировать');
    }
  };

  const handleViewHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && currentChatId) {
      loadMessages(currentChatId).then(() => loadOlderMessages(currentChatId)).catch(() => {});
    }
  };

  useEffect(() => {
    if (!showHistory) return;
    const el = historyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [showHistory, history]);

  const handleSendMessage = async (message: string) => {
    const newMessage = {
      id: Date.now(),
      text: message,
      isOutgoing: true,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    setNewMessages(prev => ({
      ...prev,
      [currentDialog.id]: [...(prev[currentDialog.id] || []), newMessage]
    }));
    try {
      await sendMessage(currentChatId, message);
    } catch {
      // ignore
    }
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
    if (!previewFile || !currentChatId || isSendingMedia) return;
    setIsSendingMedia(true);
    try {
      const caption = previewCaption.trim() || undefined;
      await sendMedia(currentChatId, previewFile, previewType, caption);
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
    if (file.size > 50 * 1024 * 1024) {
      toast.error('Файл больше 50 MB не отправляется');
      e.target.value = '';
      return;
    }
    openPreview(file, type);
    e.target.value = '';
  };

  const stopRecording = (shouldSend: boolean) => {
    shouldSendRecordingRef.current = shouldSend;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (!currentChatId) return;
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
        if (shouldSendRecordingRef.current && chunksRef.current.length > 0 && currentChatId) {
          const recordedType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/ogg';
          const blob = new Blob(chunksRef.current, { type: recordedType });
          await sendMedia(currentChatId, blob, 'voice');
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch (err: any) {
      console.error('Recording error', err);
      toast.error('Ошибка доступа к микрофону: ' + (err.message || 'Разрешите доступ в браузере'));
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          shouldSendRecordingRef.current = false;
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const getCurrentMessages = () => {
    const dialogNewMessages = newMessages[currentDialog.id] || [];
    return dialogNewMessages;
  };

  if (!currentDialog) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8 text-center">
          <h2 className="text-xl font-semibold mb-4">Очередь пуста</h2>
          <Button onClick={() => navigate('/home')}>
            На главную
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border p-4 flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0 text-center">
          <h1 className="font-semibold leading-tight">Разбор очереди</h1>
          {queueIds.length > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
              В очереди: {queueIds.length}
            </p>
          )}
        </div>
      </div>

      <QueueFilter onChange={setFilter} />

      {/* Dialog */}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-2xl p-6">
          <div className="space-y-6">
            {/* Contact Info */}
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Avatar className="h-12 w-12">
                  <AvatarFallback>{currentDialog.name[0]}</AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="text-lg font-semibold">{currentDialog.name}</h2>
                  {currentFolderLabel && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Folder className="h-3 w-3" aria-hidden />
                      <span>{currentFolderLabel}</span>
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">{currentDialog.time}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleViewHistory}
                >
                  <MessageCircle className="w-4 h-4 mr-2" />
                  {showHistory ? 'Скрыть' : 'История'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/chat/${currentChatId}`, { state: { preloadFull: true } })}
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Открыть чат
                </Button>
              </div>
            </div>

            {/* Messages */}
            <div ref={historyRef} className={`space-y-4 ${showHistory ? 'max-h-96 overflow-y-auto' : ''}`}>
              {showHistory && history.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground font-medium">История сообщений:</p>
                  {history.slice(0, -1).map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.isOutgoing ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-xs px-3 py-2 rounded-lg text-sm ${
                          message.isOutgoing
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        }`}
                      >
                        {message.senderName && (
                          <p className="text-xs font-semibold text-blue-500 mb-0.5">{message.senderName}</p>
                        )}
                        {message.mediaType && message.mediaUrl && (
                          <MediaRenderer
                            mediaType={message.mediaType}
                            mediaUrl={message.mediaUrl}
                            fileName={message.fileName}
                            fileSize={(message as any).fileSize}
                            mimeType={(message as any).mimeType}
                            duration={message.duration}
                            onLightbox={(item) => setLightboxItem(item)}
                          />
                        )}
                        <p>{message.text}</p>
                        <p className={`text-xs mt-1 ${
                          message.isOutgoing ? 'text-primary-foreground/70' : 'text-muted-foreground'
                        }`}>
                          {message.time}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div className="border-t border-border pt-3" />
                </div>
              )}
              
              {/* Current Message */}
              {(() => {
                const lastMsg = state.messages[currentChatId]?.at(-1);
                const queueMeta = state.queueMeta?.[currentChatId];
                const topicTitle = queueMeta?.topic_title ?? null;
                return (
                  <div className="bg-muted p-4 rounded-lg space-y-2">
                    {topicTitle && (
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        # {topicTitle}
                      </p>
                    )}
                    {isGroupChat && lastMsg && !lastMsg.isOutgoing && lastMsg.senderName && (
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
                    {!lastMsg?.text && !lastMsg?.mediaType && <p className="text-sm whitespace-pre-wrap break-words">{currentDialog.lastMessage}</p>}
                    <p className="text-xs text-muted-foreground">
                      {lastMsg ? new Date(lastMsg.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : currentDialog.time}
                    </p>
                  </div>
                );
              })()}

              {/* New Messages */}
              {getCurrentMessages().length > 0 && (
                <div className="space-y-2">
                  <div className="border-t border-border pt-3">
                    <p className="text-xs text-muted-foreground font-medium">Ваши сообщения:</p>
                  </div>
                  {getCurrentMessages().map((message) => (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-xs px-3 py-2 rounded-lg text-sm bg-primary text-primary-foreground">
                        <p>{message.text}</p>
                        <p className="text-xs mt-1 text-primary-foreground/70">
                          {message.time}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </Card>
      </div>

      {/* Media Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={closePreview}>
          <div className="bg-background rounded-xl shadow-2xl max-w-md w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">
                {previewType === 'photo' ? 'Отправить фото' : previewType === 'video' ? 'Отправить видео' : 'Отправить файл'}
              </h3>
              <Button variant="ghost" size="icon" onClick={closePreview}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            {(previewType === 'photo' || previewType === 'video') ? (
              <div className="flex justify-center max-h-64 overflow-hidden rounded-lg bg-muted">
                {previewType === 'photo' && previewUrl && (
                  <img src={previewUrl} alt="Preview" className="max-h-64 object-contain" />
                )}
                {previewType === 'video' && previewUrl && (
                  <video src={previewUrl} controls className="max-h-64 object-contain" />
                )}
              </div>
            ) : (
              <div className="p-3 rounded-md bg-muted text-sm break-words">
                <p className="font-medium">{previewFile.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(previewFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            )}
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

      {/* Custom Message Input */}
      <div className="border-t border-border p-4 relative">
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFileChange(e, 'photo')} />
        <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={(e) => handleFileChange(e, 'video')} />
        <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => handleFileChange(e, 'document')} />
        {showAttach && (
          <AttachMenu
            onPickPhoto={() => imageInputRef.current?.click()}
            onPickVideo={() => videoInputRef.current?.click()}
            onPickFile={() => fileInputRef.current?.click()}
          />
        )}
        {isRecording ? (
          <div className="flex items-center gap-2 max-w-2xl mx-auto rounded-full border border-border bg-muted/40 px-3 py-2">
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
          <form onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.target as HTMLFormElement);
            const message = String(formData.get('message') || '');
            if (message.trim()) {
              handleSendMessage(message.trim());
              (e.target as HTMLFormElement).reset();
            }
          }} className={`flex gap-2 max-w-2xl mx-auto ${showHistory ? 'pointer-events-auto' : ''}`}>
            <Button type="button" variant="ghost" size="icon" onClick={() => setShowAttach(v => !v)}>
              <Paperclip className="h-4 w-4" />
            </Button>
            <Input
              name="message"
              placeholder="Введите сообщение..."
              className="flex-1"
              autoComplete="off"
              onFocus={() => setShowAttach(false)}
            />
            <Button type="button" size="icon" variant="secondary" onClick={startRecording}>
              <Mic className="h-4 w-4" />
            </Button>
            <Button type="submit" size="icon">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        )}
      </div>

      {/* Action Buttons */}
      <QueueActionsBar
        chatId={currentChatId ?? 0}
        chatTitle={currentDialog?.name ?? ""}
        onDone={handleDone}
        onSnooze={handleSnooze}
        onSkip={handleSkip}
        onArchive={handleArchive}
        onTaskCreated={handleTaskCreated}
      />

      <Lightbox item={lightboxItem} onClose={() => setLightboxItem(null)} />
    </div>
  );
};

export default QueuePage;
