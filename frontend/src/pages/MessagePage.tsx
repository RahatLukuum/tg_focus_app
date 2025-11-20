import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Search } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';

interface Contact { id: number; name: string; lastMessage?: string; time?: string }

const MessagePage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const { state, loadChats } = useTelegram();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const isIdPhoneOrUsername = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return false;
    const isNumericId = /^\d+$/.test(q); // allow any length for user id
    const isPhone = /^\+?\d[\d\s\-()]{4,}$/.test(q); // phone with at least 5 digits total
    const isUsername = /^@?[a-zA-Z0-9_]{5,}$/.test(q); // basic telegram username heuristic
    return isNumericId || isPhone || isUsername;
  }, [searchQuery]);

  useEffect(() => {
    const shouldRefresh = (location.state as any)?.refresh;
    const proceed = async () => {
      if (shouldRefresh || state.chats.length === 0) {
        await loadChats();
      }
      const list: Contact[] = (state.chats || []).map(c => ({
        id: c.id,
        name: c.title,
        lastMessage: c.lastMessage?.text,
        time: c.lastMessage ? new Date(c.lastMessage.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : undefined,
      }));
      setContacts(list);
    };
    proceed().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const filteredContacts = contacts.filter(contact =>
    contact.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleContactSelect = (contactId: number) => {
    navigate(`/chat/${contactId}`);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold flex-1">Написать сообщение</h1>
      </div>

      {/* Search */}
      <div className="p-4 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Поиск контактов… (имя, +7..., ID)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-24"
            autoFocus
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && isIdPhoneOrUsername) {
                e.preventDefault();
                try {
                  const value = searchQuery.trim();
                  const isNumericId = /^\d+$/.test(value);
                  let userId: number | undefined;
                  let phone: string | undefined;
                  let username: string | undefined;
                  if (isNumericId) {
                    userId = parseInt(value, 10);
                  } else {
                    if (/^@?[a-zA-Z0-9_]{5,}$/.test(value)) {
                      username = value.startsWith('@') ? value : `@${value}`;
                    } else {
                      phone = value;
                    }
                  }
                  const res = await telegramApi.resolveContact({ userId, phone, username } as any);
                  navigate(`/chat/${res.chatId}`);
                } catch (_) {}
              }
            }}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <Button
              variant={isIdPhoneOrUsername ? 'default' : 'secondary'}
              disabled={!isIdPhoneOrUsername}
              onClick={async () => {
                try {
                  const value = searchQuery.trim();
                  if (!isIdPhoneOrUsername) return;
                  const isNumericId = /^\d+$/.test(value);
                  let userId: number | undefined;
                  let phone: string | undefined;
                  let username: string | undefined;
                  if (isNumericId) {
                    userId = parseInt(value, 10);
                  } else {
                    if (/^@?[a-zA-Z0-9_]{5,}$/.test(value)) {
                      username = value.startsWith('@') ? value : `@${value}`;
                    } else {
                      phone = value;
                    }
                  }
                  const res = await telegramApi.resolveContact({ userId, phone, username } as any);
                  navigate(`/chat/${res.chatId}`);
                } catch (_) {}
              }}
            >
              Перейти
            </Button>
          </div>
        </div>
      </div>

      {/* Contacts List */}
      <div className="flex-1 overflow-y-auto">
        {filteredContacts.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">Контакты не найдены</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredContacts.map((contact) => (
              <button
                key={contact.id}
                onClick={() => handleContactSelect(contact.id)}
                className="w-full p-4 flex items-center gap-3 hover:bg-muted transition-colors text-left"
              >
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{contact.name[0]}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{contact.name}</h3>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessagePage;