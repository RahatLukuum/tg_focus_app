import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Search, Bookmark } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import { ContactsFilter, type FilterState } from '@/components/message/ContactsFilter';
import { useFolders } from '@/hooks/useFolders';

interface ListItem { id: number; name: string; lastMessage?: string; type: string; isForum?: boolean }

const MessagePage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<FilterState>({ types: [], folderIds: [] });
  const { state, loadChats } = useTelegram();
  const { chatToFolders } = useFolders();

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

  const allItems: ListItem[] = useMemo(() => {
    const items: ListItem[] = [];
    const includeType = (t: string) => filter.types.length === 0 || filter.types.includes(t);
    if (includeType("private")) {
      items.push(
        ...state.chats
          .filter((c) => c.type === "private")
          .map((c) => ({ id: c.id, name: c.title, lastMessage: c.lastMessage?.text, type: c.type, isForum: c.isForum })),
      );
    }
    if (includeType("groups")) {
      items.push(
        ...state.chats
          .filter((c) => c.type === "group" || c.type === "supergroup")
          .map((c) => ({ id: c.id, name: c.title, lastMessage: c.lastMessage?.text, type: c.type, isForum: c.isForum })),
      );
    }
    if (includeType("contacts")) {
      items.push(
        ...(state.contacts || []).map((c) => ({ id: c.id, name: c.title, type: "private" as const, isForum: false })),
      );
    }
    return items;
  }, [state.chats, state.contacts, filter.types]);

  const filtered = useMemo(() => {
    let list = allItems;
    if (filter.folderIds.length > 0) {
      list = list.filter((item) => {
        const folders = chatToFolders.get(item.id) ?? [];
        return folders.some((id) => filter.folderIds.includes(id));
      });
    }
    return list.filter((item) =>
      item.name.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [allItems, filter.folderIds, chatToFolders, searchQuery]);

  const handleItemClick = (item: ListItem) => {
    if (item.isForum) {
      navigate(`/chat/${item.id}/topics`);
    } else {
      navigate(`/chat/${item.id}`);
    }
  };

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

      {/* Chip filters */}
      <ContactsFilter
        typeCounts={{
          private: state.chats.filter((c) => c.type === "private").length,
          groups: state.chats.filter((c) => c.type === "group" || c.type === "supergroup").length,
          contacts: (state.contacts || []).length,
        }}
        onChange={setFilter}
      />

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-muted-foreground">
              {searchQuery ? 'Ничего не найдено' : 'Нет чатов'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((item) => {
              const isSavedMessages = item.id === state.auth.user?.id;
              const displayName = isSavedMessages ? 'Избранное' : item.name;
              return (
                <button
                  key={item.id}
                  onClick={() => handleItemClick(item)}
                  className="w-full p-4 flex items-center gap-3 hover:bg-muted transition-colors text-left"
                >
                  {isSavedMessages ? (
                    <div className="h-10 w-10 rounded-full bg-blue-500 flex items-center justify-center shrink-0">
                      <Bookmark className="h-5 w-5 text-white" aria-hidden />
                    </div>
                  ) : (
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{item.name?.[0] || '?'}</AvatarFallback>
                    </Avatar>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{displayName}</h3>
                    {item.lastMessage && (
                      <p className="text-sm text-muted-foreground truncate">{item.lastMessage}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessagePage;
