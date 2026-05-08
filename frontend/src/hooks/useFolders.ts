import { useEffect, useMemo, useState } from "react";
import { foldersApi, type Folder, type FoldersPayload } from "@/services/foldersApi";

type State = {
  folders: Folder[];
  /** Map from chat_id (number) → folder_ids array. Empty array if the chat
   * is not in any user folder. */
  chatToFolders: Map<number, number[]>;
  isLoading: boolean;
  error: string | null;
};

const empty: State = {
  folders: [],
  chatToFolders: new Map(),
  isLoading: true,
  error: null,
};

/**
 * Loads the user's Telegram folders once on mount. On error, exposes the
 * message via `error` and falls back to an empty payload — the rest of the UI
 * keeps working without folder filtering.
 */
export function useFolders(account = ""): State {
  const [payload, setPayload] = useState<FoldersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    foldersApi
      .list(account)
      .then((p) => {
        if (!cancelled) setPayload(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const chatToFolders = useMemo(() => {
    const m = new Map<number, number[]>();
    if (!payload) return m;
    for (const [k, v] of Object.entries(payload.chat_to_folders)) {
      const cid = Number(k);
      if (Number.isFinite(cid)) m.set(cid, v);
    }
    return m;
  }, [payload]);

  if (!payload) return { ...empty, isLoading, error };
  return { folders: payload.folders, chatToFolders, isLoading, error };
}
