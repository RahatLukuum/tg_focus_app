import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MessageSquare, Users, LogOut, ListTodo, Loader2 } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';

const HomePage = () => {
  const navigate = useNavigate();
  const { state } = useTelegram();
  const [queueIds, setQueueIds] = useState<number[]>([]);
  const [queueLoaded, setQueueLoaded] = useState(false);

  useEffect(() => {
    if (!state.auth.isAuthenticated || !state.isInitialized) return;
    let cancelled = false;
    const load = async () => {
      try {
        const q = await telegramApi.getQueue();
        if (!cancelled) {
          setQueueIds(Array.isArray(q) ? q : []);
          setQueueLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setQueueIds([]);
          setQueueLoaded(true);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [state.queueRevision, state.isInitialized, state.auth.isAuthenticated]);

  const queueCounts = useMemo(() => {
    let priv = 0;
    let grp = 0;
    for (const cid of queueIds) {
      const chat = state.chats.find((c) => c.id === cid);
      const t = chat?.type;
      if (t === 'private' && cid > 0) priv += 1;
      else if ((t === 'group' || t === 'supergroup') && cid < 0) grp += 1;
      else if (!chat) {
        // Telegram id convention: positive = private, negative = group.
        if (cid > 0) priv += 1;
        else grp += 1;
      }
    }
    return { priv, grp, total: queueIds.length };
  }, [queueIds, state.chats]);

  // Show spinner until the very first queue fetch resolves OR while chats are
  // being bootstrapped (queue counts depend on chats for the private/group
  // classification).
  const chatsLoading = state.isLoading || state.chats.length === 0;
  const showSpinner = !queueLoaded || chatsLoading;

  const handleLogout = () => {
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <div className="space-y-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Главная</h1>
          </div>
          
          <div className="space-y-4">
            <Button 
              className="w-full h-16 text-lg"
              onClick={() => navigate('/message', { state: { refresh: true } })}
            >
              <MessageSquare className="w-6 h-6 mr-3" />
              Написать сообщение
            </Button>
            
            <Button
              className="w-full h-16 text-lg flex items-center justify-center gap-3"
              onClick={() => navigate('/queue')}
            >
              <Users className="w-6 h-6 shrink-0" />
              {showSpinner ? (
                <span className="flex items-center gap-2">
                  Разбор очереди
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                </span>
              ) : (
                <span className="tabular-nums flex flex-col leading-tight items-start">
                  <span>Разбор очереди ({queueCounts.total})</span>
                  <span className="text-xs opacity-80 font-normal">
                    личные {queueCounts.priv} · группы {queueCounts.grp}
                  </span>
                </span>
              )}
            </Button>

            <Button 
              className="w-full h-16 text-lg"
              variant="outline"
              onClick={() => navigate('/todo')}
            >
              <ListTodo className="w-6 h-6 mr-3" />
              Список задач
            </Button>
          </div>

          <Button 
            variant="ghost" 
            className="w-full"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Выйти
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default HomePage;