export type Folder = {
  id: number;
  title: string;
  chat_ids: number[];
};

export type FoldersPayload = {
  folders: Folder[];
  /** Map from chat_id (string-encoded by JSON) to folder_ids array. */
  chat_to_folders: Record<string, number[]>;
};

const BASE_URL: string = (() => {
  const envBase = (import.meta as any).env?.VITE_API_BASE_URL as string | undefined;
  if (envBase && envBase.trim()) return envBase.trim();
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
})();

const url = (path: string) => `${BASE_URL}${path}`;

async function asJson<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

export const foldersApi = {
  async list(account = ""): Promise<FoldersPayload> {
    const params = account ? `?account=${encodeURIComponent(account)}` : "";
    return asJson<FoldersPayload>(await fetch(url(`/folders${params}`)));
  },
};
