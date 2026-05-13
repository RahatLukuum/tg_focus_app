import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Search, Bookmark, MoreVertical, Archive, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';
import {
  MessageTabs,
  getInitialTabState,
  type TabState,
} from '@/components/message/MessageTabs';
import { useFolders } from '@/hooks/useFolders';
import type { Chat } from '@/types/telegram';

interface ListItem {
  id: number;
  name: string;
  lastMessage?: string;
  type: string;
  isForum?: boolean;
  isArchived?: boolean;
}

const MessagePage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const [tabs, setTabs] = useState<TabState>(getInitialTabState);
  const [fullChatsLoaded, setFullChatsLoaded] = useState(false);
  const { state, loadChats, dispatch } = useTelegram();
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

  // Background fetch the FULL dialog history (limit=0 = no cap) once per
  // mount, so the user sees every chat ever, not just the bootstrap's first
  // 100. Bootstrap stays cheap; this fills in the rest within ~1-3s.
  useEffect(() => {
    if (fullChatsLoaded || !state.auth.isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await telegramApi.getChats(0);
        if (!cancelled && all.length > 0) {
          dispatch({ type: 'SET_CHATS', payload: all });
        }
      } catch {
        /* best-effort; keep bootstrap subset visible on error */
      } finally {
        if (!cancelled) setFullChatsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.auth.isAuthenticated]);

  // Lazy-load archived dialogs the first time the user enters Archive scope.
  useEffect(() => {
    if (tabs.scope.kind !== 'archive' || state.archivedLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const items = await telegramApi.getArchivedDialogs();
        if (!cancelled) dispatch({ type: 'SET_ARCHIVED_CHATS', payload: items });
      } catch {
        if (!cancelled) dispatch({ type: 'SET_ARCHIVED_CHATS', payload: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabs.scope.kind, state.archivedLoaded, dispatch]);

  // The source list depends on scope: archive → archivedChats, else → main chats.
  const sourceChats: Chat[] = useMemo(() => {
    if (tabs.scope.kind === 'archive') return state.archivedChats;
    if (tabs.scope.kind === 'folder') {
      const fid = tabs.scope.id;
      return state.chats.filter((c) => (chatToFolders.get(c.id) || []).includes(fid));
    }
    return state.chats;
  }, [tabs.scope, state.chats, state.archivedChats, chatToFolders]);

  const allItems: ListItem[] = useMemo(() => {
    const items: ListItem[] = [];
    if (tabs.type === 'private') {
      items.push(
        ...sourceChats
          .filter((c) => c.type === 'private')
          .map((c) => ({
            id: c.id,
            name: c.title,
            lastMessage: c.lastMessage?.text,
            type: c.type,
            isForum: c.isForum,
            isArchived: tabs.scope.kind === 'archive' || !!c.isArchived,
          })),
      );
    } else if (tabs.type === 'groups') {
      items.push(
        ...sourceChats
          .filter((c) => c.type === 'group' || c.type === 'supergroup')
          .map((c) => ({
            id: c.id,
            name: c.title,
            lastMessage: c.lastMessage?.text,
            type: c.type,
            isForum: c.isForum,
            isArchived: tabs.scope.kind === 'archive' || !!c.isArchived,
          })),
      );
    } else if (tabs.type === 'contacts' && tabs.scope.kind !== 'archive') {
      // Contacts within a folder: keep only those in that folder. In "All" — full list.
      let contacts = state.contacts || [];
      if (tabs.scope.kind === 'folder') {
        const fid = tabs.scope.id;
        contacts = contacts.filter((c) => (chatToFolders.get(c.id) || []).includes(fid));
      }
      items.push(
        ...contacts.map((c) => ({
          id: c.id,
          name: c.title,
          type: 'private' as const,
          isForum: false,
          isArchived: false,
        })),
      );
    }
    return items;
  }, [sourceChats, state.contacts, tabs.scope, tabs.type, chatToFolders]);

  const typeCounts = useMemo(() => {
    const c: Record<'private' | 'groups' | 'contacts', number> = {
      private: sourceChats.filter((c) => c.type === 'private').length,
      groups: sourceChats.filter((c) => c.type === 'group' || c.type === 'supergroup').length,
      contacts:
        tabs.scope.kind === 'archive'
          ? 0
          : tabs.scope.kind === 'folder'
            ? (state.contacts || []).filter((c) =>
                (chatToFolders.get(c.id) || []).includes((tabs.scope as { id: number }).id),
              ).length
            : (state.contacts || []).length,
    };
    return c;
  }, [sourceChats, state.contacts, tabs.scope, chatToFolders]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((item) => {
      const name = (item.name || '').toLowerCase();
      if (name.includes(q)) return true;
      const savedAlias = item.id === state.auth.user?.id ? 'избранное' : '';
      return savedAlias && savedAlias.includes(q);
    });
  }, [allItems, searchQuery, state.auth.user?.id]);

  const handleItemClick = (item: ListItem) => {
    if (item.type === 'supergroup' && item.isForum) {
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

  const handleToggleArchive = useCallback(
    async (item: ListItem) => {
      const target = item.isArchived ? 'unarchive' : 'archive';
      try {
        if (target === 'archive') {
          await telegramApi.archiveChat(item.id);
          dispatch({ type: 'SET_CHAT_ARCHIVED', payload: { chatId: item.id, archived: true } });
          toast.success(`«${item.name}» в архиве`);
        } else {
          await telegramApi.unarchiveChat(item.id);
          dispatch({ type: 'SET_CHAT_ARCHIVED', payload: { chatId: item.id, archived: false } });
          toast.success(`«${item.name}» восстановлен`);
        }
      } catch (e: any) {
        toast.error(e?.message || 'Не удалось изменить архив');
      }
    },
    [dispatch],
  );

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
      <MessageTabs state={tabs} onChange={setTabs} typeCounts={typeCounts} />

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
                <div
                  key={item.id}
                  className="w-full p-4 flex items-center gap-3 hover:bg-muted transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => handleItemClick(item)}
                    className="flex-1 flex items-center gap-3 text-left min-w-0"
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
                  {tabs.type !== 'contacts' && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={(e) => e.stopPropagation()}
                          aria-label="Действия"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => handleToggleArchive(item)}
                        >
                          {item.isArchived ? (
                            <>
                              <ArchiveRestore className="h-4 w-4 mr-2" />
                              Из архива
                            </>
                          ) : (
                            <>
                              <Archive className="h-4 w-4 mr-2" />
                              В архив
                            </>
                          )}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessagePage;
