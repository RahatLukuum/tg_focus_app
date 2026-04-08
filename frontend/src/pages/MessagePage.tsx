import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Search, MessageSquare, Users, BookUser } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';

interface ListItem { id: number; name: string; lastMessage?: string; type: string }

type Tab = 'private' | 'groups' | 'contacts';

const MessagePage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const [tab, setTab] = useState<Tab>('private');
  const { state, loadChats } = useTelegram();

  const isIdPhoneOrUsername = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return false;
    const isNumericId = /^\d+$/.test(q);
    const isPhone = /^\+?\d[\d\s\-()]{4,}$/.test(q);
    const isUsername = /^@?[a-zA-Z0-9_]{5,}$/.test(q);
    return isNumericId || isPhone || isUsername;
  }, [searchQuery]);

  useEffect(() => {
    const shouldRefresh = (location.state as any)?.refresh;
    if (shouldRefresh || state.chats.length === 0) {
      loadChats().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const privateChats: ListItem[] = useMemo(() =>
    state.chats.filter(c => c.type === 'private').map(c => ({
      id: c.id,
      name: c.title,
      lastMessage: c.lastMessage?.text,
      type: c.type,
    })),
    [state.chats]
  );

  const groupChats: ListItem[] = useMemo(() =>
    state.chats.filter(c => c.type === 'group' || c.type === 'supergroup').map(c => ({
      id: c.id,
      name: c.title,
      lastMessage: c.lastMessage?.text,
      type: c.type,
    })),
    [state.chats]
  );

  const contactsList: ListItem[] = useMemo(() =>
    (state.contacts || []).map(c => ({
      id: c.id,
      name: c.title,
      type: 'private',
    })),
    [state.contacts]
  );

  const currentList = tab === 'private' ? privateChats : tab === 'groups' ? groupChats : contactsList;

  const filtered = currentList.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const resolveAndNavigate = async (value: string) => {
    try {
      const isNumericId = /^\d+$/.test(value);
      let userId: number | undefined;
      let phone: string | undefined;
      let username: string | undefined;
      if (isNumericId) {
        userId = parseInt(value, 10);
      } else if (/^@?[a-zA-Z0-9_]{5,}$/.test(value)) {
        username = value.startsWith('@') ? value : `@${value}`;
      } else {
        phone = value;
      }
      const res = await telegramApi.resolveContact({ userId, phone, username } as any);
      navigate(`/chat/${res.chatId}`);
    } catch (_) {}
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
            placeholder="Поиск… (имя, +7..., ID, @username)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-24"
            autoFocus
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && isIdPhoneOrUsername) {
                e.preventDefault();
                await resolveAndNavigate(searchQuery.trim());
              }
            }}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            <Button
              variant={isIdPhoneOrUsername ? 'default' : 'secondary'}
              disabled={!isIdPhoneOrUsername}
              size="sm"
              onClick={() => resolveAndNavigate(searchQuery.trim())}
            >
              Перейти
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab('private')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            tab === 'private' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <MessageSquare className="h-4 w-4" />
          Личные
          <span className="text-xs opacity-60">({privateChats.length})</span>
        </button>
        <button
          onClick={() => setTab('groups')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            tab === 'groups' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users className="h-4 w-4" />
          Группы
          <span className="text-xs opacity-60">({groupChats.length})</span>
        </button>
        <button
          onClick={() => setTab('contacts')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            tab === 'contacts' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <BookUser className="h-4 w-4" />
          Контакты
          <span className="text-xs opacity-60">({contactsList.length})</span>
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-muted-foreground">
              {searchQuery ? 'Ничего не найдено' : tab === 'private' ? 'Нет личных чатов' : tab === 'groups' ? 'Нет групп' : 'Нет контактов'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => navigate(`/chat/${item.id}`)}
                className="w-full p-4 flex items-center gap-3 hover:bg-muted transition-colors text-left"
              >
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{item.name?.[0] || '?'}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{item.name}</h3>
                  {item.lastMessage && (
                    <p className="text-sm text-muted-foreground truncate">{item.lastMessage}</p>
                  )}
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
