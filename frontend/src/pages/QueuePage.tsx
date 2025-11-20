import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ArrowLeft, Check, Clock, Plus, MessageCircle, Send } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useTelegram } from '@/contexts/TelegramContext';
import { telegramApi } from '@/services/telegramApi';

type UiMsg = { id: number; text: string; isOutgoing: boolean; time: string };

const QueuePage = () => {
  const navigate = useNavigate();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [queueIds, setQueueIds] = useState<number[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [newMessages, setNewMessages] = useState<Record<number, Array<{
    id: number;
    text: string;
    isOutgoing: boolean;
    time: string;
  }>>>({});
  const { state, loadMessages, loadOlderMessages, sendMessage, loadChats } = useTelegram();
  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // начальная загрузка очереди
    fetchQueue();
    if (!state.chats || state.chats.length === 0) {
      loadChats().catch(() => {});
    }
    // моментально подтягивать очередь при каждом входящем событии
    // сигнал приходит через TelegramContext: state.lastIncomingAt/state.lastIncomingChatId
    // дополнительный легкий пуллинг реже как запасной механизм
    const int = setInterval(fetchQueue, 15000);
    return () => clearInterval(int);
  }, []);

  // При фиксировании входящего сообщения — подтянуть очередь немедленно
  useEffect(() => {
    if (state.lastIncomingChatId) {
      fetchQueue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastIncomingAt, state.lastIncomingChatId]);

  const fetchQueue = async () => {
    try {
      const ids = await telegramApi.getQueue();
      setQueueIds(prev => {
        // если есть новые id, добавим их в конец, сохраним текущий порядок
        const set = new Set(prev);
        const added: number[] = [];
        for (const id of ids) {
          if (!set.has(id)) added.push(id);
        }
        // также если на бэке удалили — поддержим актуальность и порядок, оставив только пришедшие
        const filtered = prev.filter(id => ids.includes(id));
        return [...filtered, ...added];
      });
    } catch {}
  };

  const currentChatId = queueIds[currentIndex];
  const currentChat = state.chats.find(c => c.id === currentChatId);
  useEffect(() => {
    if (currentChatId) {
      loadMessages(currentChatId).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId]);
  const history: UiMsg[] = useMemo(() => {
    const list = state.messages[currentChatId] || [];
    return list.map(m => ({
      id: m.id,
      text: m.text,
      isOutgoing: m.isOutgoing,
      time: new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    }));
  }, [state.messages, currentChatId]);

  const currentDialog = currentChatId ? {
    id: currentChatId,
    name: currentChat?.title || `Чат ${currentChatId}`,
    lastMessage: history.at(-1)?.text || '',
    time: history.at(-1)?.time || '',
  } : undefined as any;

  const handleAction = async (action: 'done' | 'delay' | 'task') => {
    if (!currentChatId) return;
    const map: Record<string,string> = { delay: 'postpone', task: 'task', done: 'done' };
    try {
      const newQueue = await telegramApi.queueAction(currentChatId, map[action] as any);
      setQueueIds(newQueue);
      setCurrentIndex(i => Math.min(i, Math.max(0, (newQueue.length - 1))));
    } catch {}
  };

  const handleViewHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && currentChatId) {
      // при открытии истории сразу догружаем побольше сообщений
      loadMessages(currentChatId).then(() => loadOlderMessages(currentChatId)).catch(() => {});
    }
  };

  // Scroll history to bottom when shown or updated
  useEffect(() => {
    if (!showHistory) return;
    const el = historyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [showHistory, history]);

  const handleSendMessage = async (message: string) => {
    const newMessage = {
      id: Date.now(),
      text: message,
      isOutgoing: true,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    setNewMessages(prev => ({
      ...prev,
      [currentDialog.id]: [...(prev[currentDialog.id] || []), newMessage]
    }));
    try {
      await sendMessage(currentChatId, message);
    } catch {
      // ignore UI error here; error toast уже в контексте
    }
  };

  const getCurrentMessages = () => {
    const dialogNewMessages = newMessages[currentDialog.id] || [];
    return dialogNewMessages;
  };

  if (!currentDialog) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md p-8 text-center">
          <h2 className="text-xl font-semibold mb-4">Очередь пуста</h2>
          <Button onClick={() => navigate('/home')}>
            На главную
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border p-4 flex items-center justify-between">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold">Разбор очереди</h1>
        <div className="text-sm text-muted-foreground">
          {currentIndex + 1} из {queueIds.length}
        </div>
      </div>

      {/* Dialog */}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-2xl p-6">
          <div className="space-y-6">
            {/* Contact Info */}
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <Avatar className="h-12 w-12">
                  <AvatarFallback>{currentDialog.name[0]}</AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="text-lg font-semibold">{currentDialog.name}</h2>
                  <p className="text-sm text-muted-foreground">{currentDialog.time}</p>
                </div>
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleViewHistory}
              >
                <MessageCircle className="w-4 h-4 mr-2" />
                {showHistory ? 'Скрыть историю' : 'История'}
              </Button>
            </div>

            {/* Messages */}
            <div ref={historyRef} className={`space-y-4 ${showHistory ? 'max-h-96 overflow-y-auto' : ''}`}>
              {showHistory && history.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground font-medium">История сообщений:</p>
                  {history.slice(0, -1).map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.isOutgoing ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-xs px-3 py-2 rounded-lg text-sm ${
                          message.isOutgoing
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        }`}
                      >
                        <p>{message.text}</p>
                        <p className={`text-xs mt-1 ${
                          message.isOutgoing ? 'text-primary-foreground/70' : 'text-muted-foreground'
                        }`}>
                          {message.time}
                        </p>
                      </div>
                    </div>
                  ))}
                  {/* разделитель перед формой отправки */}
                  <div className="border-t border-border pt-3" />
                </div>
              )}
              
              {/* Current Message */}
              <div className="bg-muted p-4 rounded-lg">
                <p className="text-sm">{currentDialog.lastMessage}</p>
                <p className="text-xs text-muted-foreground mt-2">{currentDialog.time}</p>
              </div>

              {/* New Messages */}
              {getCurrentMessages().length > 0 && (
                <div className="space-y-2">
                  <div className="border-t border-border pt-3">
                    <p className="text-xs text-muted-foreground font-medium">Ваши сообщения:</p>
                  </div>
                  {getCurrentMessages().map((message) => (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-xs px-3 py-2 rounded-lg text-sm bg-primary text-primary-foreground">
                        <p>{message.text}</p>
                        <p className="text-xs mt-1 text-primary-foreground/70">
                          {message.time}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </Card>
      </div>

      {/* Custom Message Input */}
      <div className="border-t border-border p-4">
        <form onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.target as HTMLFormElement);
          const message = formData.get('message') as string;
          if (message.trim()) {
            handleSendMessage(message.trim());
            (e.target as HTMLFormElement).reset();
          }
        }} className={`flex gap-2 max-w-2xl mx-auto ${showHistory ? 'pointer-events-auto' : ''}`}>
          <Input
            name="message"
            placeholder="Введите сообщение..."
            className="flex-1"
            autoComplete="off"
          />
          <Button type="submit" size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>

      {/* Action Buttons */}
      <div className="border-t border-border p-4">
        <div className="flex gap-3 max-w-2xl mx-auto">
          <Button 
            className="flex-1 h-12"
            onClick={() => handleAction('done')}
          >
            <Check className="w-4 h-4 mr-2" />
            Выполнено
          </Button>
          <Button 
            variant="outline" 
            className="flex-1 h-12"
            onClick={() => handleAction('delay')}
          >
            <Clock className="w-4 h-4 mr-2" />
            Отложить
          </Button>
          <Button 
            variant="secondary" 
            className="flex-1 h-12"
            onClick={() => handleAction('task')}
          >
            <Plus className="w-4 h-4 mr-2" />
            В задачи
          </Button>
        </div>
      </div>
    </div>
  );
};

export default QueuePage;