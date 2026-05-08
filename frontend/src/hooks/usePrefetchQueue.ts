import { useEffect, useRef } from "react";
import { telegramApi } from "@/services/telegramApi";
import { getCached, setCached } from "@/services/messageCache";

const DEBOUNCE_MS = 300;
const PREFETCH_LIMIT = 50;

/**
 * When the queue cursor changes, prefetch the next 1-2 chats so navigation
 * feels instant. Skips chats already cached. Failures are silent.
 */
export function usePrefetchQueue(queueIds: number[], currentIndex: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const targetKey = `${queueIds[currentIndex + 1] ?? ""}|${queueIds[currentIndex + 2] ?? ""}`;

  useEffect(() => {
    if (queueIds.length === 0) return;
    const targets = [queueIds[currentIndex + 1], queueIds[currentIndex + 2]]
      .filter((id): id is number => typeof id === "number");

    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (targets.length === 0) return;

    timer.current = setTimeout(async () => {
      for (const chatId of targets) {
        try {
          const cached = await getCached(chatId);
          if (cached && Date.now() - cached.lastSyncAt < 60_000) continue;
          const messages = await telegramApi.getMessages(chatId, PREFETCH_LIMIT);
          if (messages.length > 0) {
            await setCached(chatId, messages);
          }
        } catch {
          /* silent */
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
}
