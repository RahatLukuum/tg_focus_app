import React, { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useTelegram } from '@/contexts/TelegramContext';
import { Message, MediaType } from '@/types/telegram';
import { cn } from '@/lib/utils';
import { Play, Pause, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

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

interface MessageListProps {
  chatId: number;
}

export const MessageList: React.FC<MessageListProps> = ({ chatId }) => {
  const { state, loadMessages } = useTelegram();
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = state.messages[chatId] || [];

  useEffect(() => {
    loadMessages(chatId);
  }, [chatId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('ru', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };

  const formatDate = (date: Date) => {
    const today = new Date();
    const messageDate = new Date(date);
    
    if (messageDate.toDateString() === today.toDateString()) {
      return 'Сегодня';
    }
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (messageDate.toDateString() === yesterday.toDateString()) {
      return 'Вчера';
    }
    
    return new Intl.DateTimeFormat('ru', {
      day: 'numeric',
      month: 'long'
    }).format(messageDate);
  };

  const shouldShowDateSeparator = (message: Message, index: number) => {
    if (index === 0) return true;
    const prevMessage = messages[index - 1];
    const currentDate = new Date(message.date).toDateString();
    const prevDate = new Date(prevMessage.date).toDateString();
    return currentDate !== prevDate;
  };

  const getUserInitials = (senderId: number) => {
    // В реальном приложении здесь была бы логика получения данных пользователя
    return senderId === state.auth.user?.id ? 'Я' : 'U';
  };

  const [fullscreenMedia, setFullscreenMedia] = useState<{url: string, type: MediaType} | null>(null);

  const renderMedia = (msg: Message) => {
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

  return (
    <ScrollArea className="h-full" ref={scrollRef}>
      <div className="p-4 space-y-2">
        {messages.map((message, index) => (
          <React.Fragment key={message.id}>
            {shouldShowDateSeparator(message, index) && (
              <div className="flex justify-center my-4">
                <div className="bg-muted px-3 py-1 rounded-full text-xs text-muted-foreground">
                  {formatDate(message.date)}
                </div>
              </div>
            )}
            
            <div
              className={cn(
                "flex gap-2 max-w-[80%]",
                message.isOutgoing ? "ml-auto flex-row-reverse" : "mr-auto"
              )}
            >
              {!message.isOutgoing && (
                <Avatar className="h-8 w-8 mt-auto">
                  <AvatarFallback className="text-xs">
                    {getUserInitials(message.senderId)}
                  </AvatarFallback>
                </Avatar>
              )}
              
              <div
                className={cn(
                  "rounded-lg px-3 py-2 max-w-full break-words",
                  message.isOutgoing
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                )}
              >
                {renderMedia(message)}
                <p className="text-sm">{message.text}</p>
                <div className={cn(
                  "flex items-center gap-1 mt-1",
                  message.isOutgoing ? "justify-end" : "justify-start"
                )}>
                  <span className={cn(
                    "text-xs",
                    message.isOutgoing 
                      ? "text-primary-foreground/70" 
                      : "text-muted-foreground"
                  )}>
                    {formatTime(message.date)}
                  </span>
                  {message.isOutgoing && (
                    <span className="text-xs text-primary-foreground/70">
                      ✓✓
                    </span>
                  )}
                </div>
              </div>
            </div>
          </React.Fragment>
        ))}
        
        {messages.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <p>Сообщений пока нет</p>
          </div>
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
    </ScrollArea>
  );
};