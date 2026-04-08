import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Plus, Trash2, Check, RotateCcw } from 'lucide-react';

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

const STORAGE_KEY = 'tg_focus_todos';

const loadTodos = (): TodoItem[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveTodos = (todos: TodoItem[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
};

const TodoPage = () => {
  const navigate = useNavigate();
  const [todos, setTodos] = useState<TodoItem[]>(loadTodos);
  const [newText, setNewText] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all');

  useEffect(() => { saveTodos(todos); }, [todos]);

  const addTodo = useCallback(() => {
    const text = newText.trim();
    if (!text) return;
    setTodos(prev => [...prev, { id: crypto.randomUUID(), text, done: false, createdAt: Date.now() }]);
    setNewText('');
  }, [newText]);

  const toggleTodo = useCallback((id: string) => {
    setTodos(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t));
  }, []);

  const removeTodo = useCallback((id: string) => {
    setTodos(prev => prev.filter(t => t.id !== id));
  }, []);

  const clearDone = useCallback(() => {
    setTodos(prev => prev.filter(t => !t.done));
  }, []);

  const filtered = todos.filter(t => {
    if (filter === 'active') return !t.done;
    if (filter === 'done') return t.done;
    return true;
  });

  const doneCount = todos.filter(t => t.done).length;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-10 bg-background border-b border-border p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/home')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold flex-1">Список задач</h1>
        <span className="text-sm text-muted-foreground">
          {doneCount}/{todos.length}
        </span>
      </div>

      <div className="p-4 border-b border-border">
        <form
          onSubmit={(e) => { e.preventDefault(); addTodo(); }}
          className="flex gap-2"
        >
          <Input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Новая задача..."
            className="flex-1"
            autoFocus
          />
          <Button type="submit" size="icon" disabled={!newText.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </form>
        <div className="flex gap-2 mt-3">
          {(['all', 'active', 'done'] as const).map(f => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Все' : f === 'active' ? 'Активные' : 'Готовые'}
            </Button>
          ))}
          {doneCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearDone} className="ml-auto text-destructive">
              <Trash2 className="h-3 w-3 mr-1" />
              Очистить
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-muted-foreground">
              {filter === 'all' ? 'Нет задач' : filter === 'active' ? 'Нет активных задач' : 'Нет завершённых задач'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((todo) => (
              <div
                key={todo.id}
                className="flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => toggleTodo(todo.id)}
                >
                  {todo.done ? (
                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </Button>
                <span className={`flex-1 text-sm ${todo.done ? 'line-through text-muted-foreground' : ''}`}>
                  {todo.text}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(todo.createdAt).toLocaleDateString('ru-RU')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() => removeTodo(todo.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TodoPage;
