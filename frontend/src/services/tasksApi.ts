export type Task = {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
  chat_id: number | null;
  chat_title: string | null;
  account: string | null;
};

const BASE_URL: string = (() => {
  const envBase = (import.meta as any).env?.VITE_API_BASE_URL as string | undefined;
  if (envBase && envBase.trim()) return envBase.trim();
  // Runtime fallback: same origin as the frontend.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
})();

const url = (path: string): string => `${BASE_URL}${path}`;

async function asJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

export const tasksApi = {
  async list(account = ''): Promise<Task[]> {
    const params = account ? `?account=${encodeURIComponent(account)}` : '';
    const data = await asJson<{ tasks: Task[] }>(
      await fetch(url(`/tasks${params}`))
    );
    return data.tasks;
  },

  async create(input: {
    text: string;
    chat_id?: number;
    chat_title?: string;
    account?: string;
  }): Promise<Task> {
    const data = await asJson<{ task: Task }>(
      await fetch(url('/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    );
    return data.task;
  },

  async update(
    id: string,
    patch: { done?: boolean; text?: string }
  ): Promise<Task> {
    const data = await asJson<{ task: Task }>(
      await fetch(url(`/tasks/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    );
    return data.task;
  },

  async remove(id: string): Promise<void> {
    await asJson(
      await fetch(url(`/tasks/${encodeURIComponent(id)}`), { method: 'DELETE' })
    );
  },

  async clearCompleted(account = ''): Promise<number> {
    const params = account ? `?account=${encodeURIComponent(account)}` : '';
    const data = await asJson<{ ok: boolean; removed: number }>(
      await fetch(url(`/tasks/completed${params}`), { method: 'DELETE' })
    );
    return data.removed;
  },
};
