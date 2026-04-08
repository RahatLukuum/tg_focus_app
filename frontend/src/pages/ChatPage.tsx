import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Send, Paperclip, Mic, Square, Image, Video, Sparkles } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import { MediaType } from '@/types/telegram';

type UiMsg = {
  id: number;
  text: string;
  isOutgoing: boolean;
  time: string;
  mediaType?: MediaType;
  mediaUrl?: string;
  duration?: number;
};

const formatDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const shouldScrollToBottomOnOpenRef = useRef(true);

  const numericChatId = parseInt(chatId || '0', 10);
  const shouldPreloadFull = !!(location.state as any)?.preloadFull;
  const contact = state.chats.find(c => c.id === numericChatId) || state.contacts?.find(c => c.id === numericChatId);
  const [remoteChatTitle, setRemoteChatTitle] = useState<string | null>(null);
  const chatTitle = contact?.title || remoteChatTitle || 'Загрузка...';

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
    if (!numericChatId) return;
    shouldScrollToBottomOnOpenRef.current = true;
    prevMsgCountRef.current = 0;
    const load = shouldPreloadFull ? preloadFullChatHistory(numericChatId) : loadMessages(numericChatId);
    load.then(() => {
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      });
    }).catch(() => {});
    if (!contact) {
      telegramApi.getChatInfo(numericChatId).then(info => {
        setRemoteChatTitle(info.title);
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericChatId, shouldPreloadFull, preloadFullChatHistory]);

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

  const messages = useMemo<UiMsg[]>(() => {
    const list = state.messages[numericChatId] || [];
    return list.map(m => ({
      id: m.id,
      text: m.text,
      isOutgoing: m.isOutgoing,
      time: new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      mediaType: m.mediaType,
      mediaUrl: m.mediaUrl,
      duration: m.duration,
    }));
  }, [state.messages, numericChatId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (shouldScrollToBottomOnOpenRef.current) {
      shouldScrollToBottomOnOpenRef.current = false;
      const raf = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
    const isNewMessage = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (isNewMessage || el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      const raf = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !numericChatId) return;
    await sendMessage(numericChatId, message.trim());
    setMessage('');
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>, type: MediaType) => {
    const file = e.target.files?.[0];
    if (!file || !numericChatId) return;
    await sendMedia(numericChatId, file, type);
    setShowAttach(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: 'audio/ogg' });
          await sendMedia(numericChatId, blob, 'voice');
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch {
      console.error('Microphone access denied');
    }
  }, [numericChatId, sendMedia]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
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

  const renderMedia = (msg: UiMsg) => {
    if (!msg.mediaType || !msg.mediaUrl) return null;
    switch (msg.mediaType) {
      case 'photo':
        return <img src={msg.mediaUrl} alt="" className="max-w-full rounded-md mb-1 cursor-pointer" loading="lazy" onClick={() => window.open(msg.mediaUrl, '_blank')} />;
      case 'video':
        return <video src={msg.mediaUrl} controls className="max-w-full rounded-md mb-1" preload="metadata" />;
      case 'voice':
        return (
          <div className="flex items-center gap-2 mb-1">
            <audio src={msg.mediaUrl} controls className="h-8 max-w-[200px]" preload="metadata" />
            {msg.duration != null && <span className="text-xs opacity-70">{formatDuration(msg.duration)}</span>}
          </div>
        );
      default:
        return <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline mb-1 block">Скачать файл</a>;
    }
  };

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

      {/* Attachment menu */}
      {/* Message Input */}
      <div className="sticky bottom-0 z-10 bg-background border-t border-border p-4 relative">
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFileSelect(e, 'photo')} />
        <input ref={videoInputRef} type="file" accept="video/*" className="hidden" onChange={(e) => handleFileSelect(e, 'video')} />
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
          <div className="flex items-center gap-3">
            <div className="flex-1 flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm font-medium">{formatDuration(recordingTime)}</span>
            </div>
            <Button variant="destructive" size="icon" onClick={stopRecording}>
              <Square className="h-4 w-4" />
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
    </div>
  );
};

export default ChatPage;