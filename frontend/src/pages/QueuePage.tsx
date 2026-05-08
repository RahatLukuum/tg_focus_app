import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Check, Clock, Plus, MessageCircle, Send, Paperclip, Mic, Image, Video, ExternalLink, X, Play, Pause, Folder } from 'lucide-react';
import { toast } from 'sonner';

const formatDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

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
import { Input } from '@/components/ui/input';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import { useFolders } from '@/hooks/useFolders';
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
  const historyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
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
      const ids = await telegramApi.getQueue();
      setQueueIds(prev => {
        const set = new Set(prev);
        const added: number[] = [];
        for (const id of ids) {
          if (!set.has(id)) added.push(id);
        }
        const filtered = prev.filter(id => ids.includes(id));
        return [...filtered, ...added];
      });
    } catch {}
  };

  useEffect(() => {
    if (state.queueRevision === 0) return;
    fetchQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.queueRevision]);

  const currentChatId = queueIds[currentIndex];
  const currentChat = state.chats.find(c => c.id === currentChatId) || state.contacts?.find(c => c.id === currentChatId);
  const [chatTitles, setChatTitles] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!currentChatId) return;
    loadMessages(currentChatId).catch(() => {});
    if (!currentChat && !chatTitles[currentChatId]) {
      telegramApi.getChatInfo(currentChatId).then(info => {
        setChatTitles(prev => ({ ...prev, [currentChatId]: info.title }));
      }).catch(() => {});
    }
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

  const handleAction = async (action: 'done' | 'delay' | 'task') => {
    if (!currentChatId) return;
    const map: Record<string,string> = { delay: 'postpone', task: 'task', done: 'done' };
    try {
      const newQueue = await telegramApi.queueAction(currentChatId, map[action] as any);
      setQueueIds(newQueue);
      setCurrentIndex(i => Math.min(i, Math.max(0, (newQueue.length - 1))));
      dispatch({ type: 'QUEUE_DIRTY' });
    } catch {}
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
        <div className="text-sm text-muted-foreground tabular-nums shrink-0 w-[4.5rem] text-right">
          {queueIds.length > 0 ? `${currentIndex + 1} / ${queueIds.length}` : '—'}
        </div>
      </div>

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
                        {renderMedia(message)}
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
              <div className="bg-muted p-4 rounded-lg">
                <p className="text-sm">{currentDialog.lastMessage}</p>
                <p className="text-xs text-muted-foreground mt-2">{currentDialog.time}</p>
              </div>

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

      {/* Custom Message Input */}
      <div className="border-t border-border p-4 relative">
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
      <div className="border-t border-border p-4">
        <div className="flex gap-3 max-w-2xl mx-auto">
          <Button 
            className="flex-1 h-12"
            onClick={() => handleAction('done')}
          >
            <Check className="w-4 h-4 mr-2" />
            Выполнено
          </Button>
          <Button 
            variant="outline" 
            className="flex-1 h-12"
            onClick={() => handleAction('delay')}
          >
            <Clock className="w-4 h-4 mr-2" />
            Отложить
          </Button>
          <Button 
            variant="secondary" 
            className="flex-1 h-12"
            onClick={() => handleAction('task')}
          >
            <Plus className="w-4 h-4 mr-2" />
            В задачи
          </Button>
        </div>
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

export default QueuePage;
