import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Send } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';

type UiMsg = { id: number; text: string; isOutgoing: boolean; time: string };

const ChatPage = () => {
  const navigate = useNavigate();
  const { chatId } = useParams();
  const [message, setMessage] = useState('');
  const { state, loadMessages, loadOlderMessages, sendMessage } = useTelegram();
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const numericChatId = parseInt(chatId || '0', 10);
  const contact = state.chats.find(c => c.id === numericChatId);

  useEffect(() => {
    if (!numericChatId) return;
    loadMessages(numericChatId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericChatId]);

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
    }));
  }, [state.messages, numericChatId]);

  // Auto-scroll to bottom when messages or chat change
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // ensure scrolling happens after DOM updates
    window.requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
        bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      } catch {}
    });
  }, [messages, numericChatId]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !numericChatId) return;
    await sendMessage(numericChatId, message.trim());
    setMessage('');
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/message')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback>{contact?.title?.[0] || 'U'}</AvatarFallback>
        </Avatar>
        <div>
          <h1 className="font-semibold">{contact?.title || 'Неизвестный контакт'}</h1>
          <p className="text-xs text-muted-foreground">в сети</p>
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
              <p className="text-sm">{msg.text}</p>
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

      {/* Message Input */}
      <div className="sticky bottom-0 z-10 bg-background border-t border-border p-4">
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Введите сообщение..."
            className="flex-1"
            autoFocus
          />
          <Button type="submit" size="icon" disabled={!message.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
};

export default ChatPage;