import React, { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useTelegram } from '@/contexts/TelegramContext';
import { Message } from '@/types/telegram';
import { cn } from '@/lib/utils';

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
    </ScrollArea>
  );
};