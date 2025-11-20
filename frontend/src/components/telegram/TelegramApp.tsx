import React, { useState } from 'react';
import { useTelegram } from '@/contexts/TelegramContext';
import { AuthForm } from './AuthForm';
import { ChatList } from './ChatList';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { Chat } from '@/types/telegram';
import { Button } from '@/components/ui/button';
import { LogOut, Settings } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export const TelegramApp: React.FC = () => {
  const { state, dispatch } = useTelegram();
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);

  if (!state.auth.isAuthenticated) {
    return <AuthForm />;
  }

  const handleLogout = () => {
    dispatch({ type: 'LOGOUT' });
    localStorage.removeItem('telegram_config');
  };

  const handleChatSelect = (chat: Chat) => {
    setSelectedChat(chat);
    dispatch({ type: 'SET_ACTIVE_CHAT', payload: chat });
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="border-b border-border p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={state.auth.user?.profilePhoto} />
            <AvatarFallback>
              {state.auth.user?.firstName?.[0] || 'U'}
            </AvatarFallback>
          </Avatar>
          <div>
            <h1 className="font-semibold">Telegram Web</h1>
            <p className="text-sm text-muted-foreground">
              {state.auth.user?.firstName} {state.auth.user?.lastName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon">
            <Settings className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex">
        {/* Chat List */}
        <div className="w-80 min-w-80">
          <ChatList 
            onChatSelect={handleChatSelect}
            selectedChatId={selectedChat?.id}
          />
        </div>

        {/* Chat Area */}
        <div className="flex-1 flex flex-col">
          {selectedChat ? (
            <>
              {/* Chat Header */}
              <div className="border-b border-border p-4 flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={selectedChat.photo} />
                  <AvatarFallback>
                    {selectedChat.title[0]}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="font-semibold">{selectedChat.title}</h2>
                  <p className="text-sm text-muted-foreground">
                    {selectedChat.type === 'private' ? 'в сети' : `${selectedChat.type}`}
                  </p>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1">
                <MessageList chatId={selectedChat.id} />
              </div>

              {/* Message Input */}
              <MessageInput chatId={selectedChat.id} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <h3 className="text-lg font-medium mb-2">Выберите чат</h3>
                <p>Выберите чат из списка слева, чтобы начать переписку</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};