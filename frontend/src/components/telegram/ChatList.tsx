import React, { useEffect } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useTelegram } from '@/contexts/TelegramContext';
import { Chat } from '@/types/telegram';
import { cn } from '@/lib/utils';

interface ChatListProps {
  onChatSelect: (chat: Chat) => void;
  selectedChatId?: number;
}

export const ChatList: React.FC<ChatListProps> = ({ onChatSelect, selectedChatId }) => {
  const { state, loadChats, dispatch } = useTelegram();

  useEffect(() => {
    loadChats();
  }, []);

  const formatTime = (date?: Date) => {
    if (!date) return '';
    return new Intl.DateTimeFormat('ru', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };

  const getChatInitials = (title: string) => {
    return title
      .split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="h-full border-r border-border">
      <div className="p-4 border-b border-border">
        <h2 className="text-lg font-semibold">Чаты</h2>
      </div>
      
      <ScrollArea className="h-[calc(100vh-80px)]">
        <div className="p-2">
          {state.chats.map((chat) => (
            <div
              key={chat.id}
              className={cn(
                "flex items-center gap-3 p-3 rounded-lg cursor-pointer hover:bg-accent transition-colors",
                selectedChatId === chat.id && "bg-accent"
              )}
              onClick={() => onChatSelect(chat)}
            >
              <Avatar className="h-12 w-12">
                <AvatarImage src={chat.photo} />
                <AvatarFallback className="bg-primary text-primary-foreground">
                  {getChatInitials(chat.title)}
                </AvatarFallback>
              </Avatar>
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-medium text-sm truncate">{chat.title}</h3>
                  {chat.lastMessage && (
                    <span className="text-xs text-muted-foreground">
                      {formatTime(chat.lastMessage.date)}
                    </span>
                  )}
                </div>
                
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground truncate">
                    {chat.lastMessage?.text || 'Нет сообщений'}
                  </p>
                  {chat.unreadCount && chat.unreadCount > 0 && (
                    <Badge variant="default" className="ml-2 text-xs">
                      {chat.unreadCount}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          ))}
          
          {state.chats.length === 0 && !state.isLoading && (
            <div className="text-center py-8 text-muted-foreground">
              <p>Чаты не найдены</p>
            </div>
          )}
          
          {state.isLoading && (
            <div className="text-center py-8 text-muted-foreground">
              <p>Загрузка чатов...</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};