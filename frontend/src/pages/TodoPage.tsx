import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { ArrowLeft, Check, MessageSquare, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { tasksApi, type Task } from '@/services/tasksApi';

const LEGACY_KEY = 'tg_focus_todos';

type LegacyTodo = { id: string; text: string; done: boolean; createdAt: number };

const TodoPage = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const migrationDone = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await tasksApi.list();
      setTasks(list);
    } catch (e: any) {
      toast.error('Не удалось загрузить задачи: ' + (e.message || ''));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // One-shot migration: read localStorage, POST each, then clear.
  useEffect(() => {
    if (migrationDone.current) return;
    migrationDone.current = true;
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) {
      load();
      return;
    }
    try {
      const legacy: LegacyTodo[] = JSON.parse(raw);
      if (!Array.isArray(legacy) || legacy.length === 0) {
        localStorage.removeItem(LEGACY_KEY);
        load();
        return;
      }
      // Sequential to preserve order; failures roll back to leaving localStorage in place.
      (async () => {
        try {
          for (const t of legacy) {
            await tasksApi.create({ text: t.text });
            // Note: legacy `done` and `createdAt` are not preserved — the
            // backend assigns a fresh created_at. Acceptable for a one-shot
            // migration of in-progress task lists.
          }
          localStorage.removeItem(LEGACY_KEY);
          toast.success(`Перенесено ${legacy.length} задач из локального хранилища`);
        } catch (e: any) {
          toast.error('Миграция задач не удалась — localStorage сохранён');
        } finally {
          await load();
        }
      })();
    } catch {
      localStorage.removeItem(LEGACY_KEY);
      load();
    }
  }, [load]);

  const visible = useMemo(() => {
    if (filter === 'open') return tasks.filter(t => !t.done);
    if (filter === 'done') return tasks.filter(t => t.done);
    return tasks;
  }, [tasks, filter]);

  const doneCount = tasks.filter(t => t.done).length;

  const addTask = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const created = await tasksApi.create({ text: trimmed });
      setTasks(prev => [...prev, created]);
      setText('');
    } catch (e: any) {
      toast.error('Не удалось создать задачу');
    }
  }, [text]);

  const toggleTask = useCallback(async (task: Task) => {
    // Optimistic
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: !t.done } : t));
    try {
      await tasksApi.update(task.id, { done: !task.done });
    } catch {
      // Revert
      setTasks(prev => prev.map(t => t.id === task.id ? task : t));
      toast.error('Не удалось обновить задачу');
    }
  }, []);

  const removeTask = useCallback(async (task: Task) => {
    setTasks(prev => prev.filter(t => t.id !== task.id));
    try {
      await tasksApi.remove(task.id);
    } catch {
      setTasks(prev => [...prev, task]);
      toast.error('Не удалось удалить задачу');
    }
  }, []);

  const clearDone = useCallback(async () => {
    const before = tasks;
    setTasks(prev => prev.filter(t => !t.done));
    try {
      await tasksApi.clearCompleted();
    } catch {
      setTasks(before);
      toast.error('Не удалось очистить выполненные');
    }
  }, [tasks]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b border-border p-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold flex-1">Задачи</h1>
        <span className="text-sm text-muted-foreground tabular-nums">
          {doneCount}/{tasks.length}
        </span>
      </div>

      <div className="p-4 border-b border-border">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addTask();
          }}
        >
          <Input
            placeholder="Новая задача..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <Button type="submit" disabled={!text.trim()}>
            Добавить
          </Button>
        </form>
        <div className="flex gap-2 mt-3 text-sm">
          {(['all', 'open', 'done'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded ${
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              {f === 'all' ? 'Все' : f === 'open' ? 'Активные' : 'Выполненные'}
            </button>
          ))}
          {doneCount > 0 && (
            <button
              onClick={clearDone}
              className="ml-auto px-2 py-1 rounded text-muted-foreground hover:text-foreground"
            >
              Очистить выполненные
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            Загрузка...
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            Нет задач
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((t) => (
              <Card
                key={t.id}
                className="m-2 p-3 flex items-center gap-3"
              >
                <button onClick={() => toggleTask(t)}>
                  {t.done ? <Check className="h-5 w-5" /> : <Square className="h-5 w-5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <span
                    className={`text-sm ${t.done ? 'line-through text-muted-foreground' : ''}`}
                  >
                    {t.text}
                  </span>
                  {t.chat_id != null && t.chat_title && (
                    <button
                      onClick={() => navigate(`/chat/${t.chat_id}`)}
                      className="ml-2 text-xs text-blue-500 inline-flex items-center gap-1 hover:underline"
                    >
                      <MessageSquare className="h-3 w-3" />
                      {t.chat_title}
                    </button>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(t.created_at * 1000).toLocaleDateString('ru-RU')}
                </span>
                <Button variant="ghost" size="icon" onClick={() => removeTask(t)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TodoPage;
