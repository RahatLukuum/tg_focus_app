import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Check, Clock, Plus, MessageCircle, Send, Paperclip, Mic, Square, Image, Video, ExternalLink, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import { MediaType } from '@/types/telegram';

type UiMsg = { id: number; text: string; isOutgoing: boolean; time: string };

function getSupportedMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const mt of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mt)) return mt;
    } catch { /* ignore */ }
  }
  return '';
}

const formatDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

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
  const historyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewType, setPreviewType] = useState<MediaType>('photo');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewCaption, setPreviewCaption] = useState('');

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
    const int = setInterval(fetchQueue, 15000);
    return () => clearInterval(int);
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

  useEffect(() => {
    if (state.lastIncomingChatId) {
      fetchQueue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastIncomingAt, state.lastIncomingChatId]);

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

  const history: UiMsg[] = useMemo(() => {
    const list = state.messages[currentChatId] || [];
    return list.map(m => ({
      id: m.id,
      text: m.text,
      isOutgoing: m.isOutgoing,
      time: new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    }));
  }, [state.messages, currentChatId]);

  const currentDialog = currentChatId ? {
    id: currentChatId,
    name: currentChat?.title || chatTitles[currentChatId] || `Чат ${currentChatId}`,
    lastMessage: history.at(-1)?.text || '',
    time: history.at(-1)?.time || '',
  } : undefined as any;

  const handleAction = async (action: 'done' | 'delay' | 'task') => {
    if (!currentChatId) return;
    const map: Record<string,string> = { delay: 'postpone', task: 'task', done: 'done' };
    try {
      const newQueue = await telegramApi.queueAction(currentChatId, map[action] as any);
      setQueueIds(newQueue);
      setCurrentIndex(i => Math.min(i, Math.max(0, (newQueue.length - 1))));
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
    if (!previewFile || !currentChatId) return;
    const caption = previewCaption.trim() || undefined;
    await sendMedia(currentChatId, previewFile, previewType, caption);
    closePreview();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: MediaType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    openPreview(file, type);
    e.target.value = '';
  };

  const startRecording = async () => {
    if (!currentChatId) return;
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      console.error('No supported audio MIME type found');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (chunksRef.current.length > 0 && currentChatId) {
          const blob = new Blob(chunksRef.current, { type: 'audio/ogg' });
          await sendMedia(currentChatId, blob, 'voice');
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch {
      // ignore
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

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
      <div className="border-b border-border p-4 flex items-center justify-between">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold">Разбор очереди</h1>
        <div className="text-sm text-muted-foreground">
          {currentIndex + 1} из {queueIds.length}
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
              <Button variant="outline" onClick={closePreview}>Отмена</Button>
              <Button onClick={sendPreview}>
                <Send className="h-4 w-4 mr-1" />
                Отправить
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
          <div className="flex items-center gap-3 max-w-2xl mx-auto">
            <div className="flex-1 flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm font-medium">{formatDuration(recordingTime)}</span>
            </div>
            <Button variant="destructive" size="icon" onClick={stopRecording}>
              <Square className="h-4 w-4" />
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
    </div>
  );
};

export default QueuePage;
