import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MessageSquare, Users, LogOut, ListTodo } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';

const HomePage = () => {
  const navigate = useNavigate();
  const { state } = useTelegram();
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    if (!state.auth.isAuthenticated || !state.isInitialized) return;
    let cancelled = false;
    const load = async () => {
      try {
        const q = await telegramApi.getQueue();
        if (!cancelled) setQueueCount(Array.isArray(q) ? q.length : 0);
      } catch {
        if (!cancelled) setQueueCount(0);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [state.queueRevision, state.isInitialized, state.auth.isAuthenticated]);

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
              <span className="tabular-nums">
                Разбор очереди ({queueCount})
              </span>
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