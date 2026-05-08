import { createStore, get, set, del, keys, entries } from "idb-keyval";
import type { Message } from "@/types/telegram";

const STORE = createStore("tg-focus-msg-cache", "chats");

const MAX_CHATS = 50;
const MAX_MSGS_PER_CHAT = 100;
const TOUCH_THROTTLE_MS = 10_000;

type Entry = {
  messages: Message[];
  lastSyncAt: number;
  lastTouchedAt: number;
};

const keyFor = (chatId: number) => `chat:${chatId}`;

// Per-chat write queue to prevent concurrent writes from losing data.
const writeQueues = new Map<number, Promise<void>>();

function withChatLock(chatId: number, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => undefined).finally(() => {
    if (writeQueues.get(chatId) === next) {
      writeQueues.delete(chatId);
    }
  });
  writeQueues.set(chatId, next);
  return next;
}

/**
 * Read cached messages for a chat. Returns null on miss or any IndexedDB
 * error (cache is best-effort — errors must not break the UI).
 * Throttles the lastTouchedAt update to at most once per TOUCH_THROTTLE_MS
 * to avoid write amplification on rapid renders.
 */
export async function getCached(chatId: number): Promise<Entry | null> {
  try {
    const e = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
    if (!e) return null;
    if (Date.now() - (e.lastTouchedAt ?? 0) > TOUCH_THROTTLE_MS) {
      void withChatLock(chatId, async () => {
        await set(keyFor(chatId), { ...e, lastTouchedAt: Date.now() }, STORE);
      });
    }
    return e;
  } catch {
    return null;
  }
}

/**
 * Replace the whole cached message list for a chat (e.g. after fresh /messages).
 */
export async function setCached(chatId: number, messages: Message[]): Promise<void> {
  return withChatLock(chatId, async () => {
    try {
      const trimmed = messages.slice(-MAX_MSGS_PER_CHAT);
      await set(
        keyFor(chatId),
        { messages: trimmed, lastSyncAt: Date.now(), lastTouchedAt: Date.now() },
        STORE,
      );
      void enforceCapacity().catch(() => {});
    } catch {
      /* best-effort */
    }
  });
}

/**
 * Append new messages (deduped by id) to the cached list and update timestamps.
 * No-op when there is no existing entry — avoids creating phantom cache entries
 * from WS-only data (which would cause history holes when the user opens the chat).
 */
export async function appendCached(
  chatId: number,
  newMessages: Message[],
): Promise<void> {
  if (newMessages.length === 0) return;
  return withChatLock(chatId, async () => {
    try {
      const existing = (await get<Entry>(keyFor(chatId), STORE)) ?? null;
      if (existing === null) return;  // don't create phantom entry from WS-only data
      const seen = new Set(existing.messages.map((m) => m.id));
      const merged = [
        ...existing.messages,
        ...newMessages.filter((m) => !seen.has(m.id)),
      ];
      merged.sort((a, b) => a.id - b.id);
      const trimmed = merged.slice(-MAX_MSGS_PER_CHAT);
      await set(
        keyFor(chatId),
        { messages: trimmed, lastSyncAt: Date.now(), lastTouchedAt: Date.now() },
        STORE,
      );
      void enforceCapacity().catch(() => {});
    } catch {
      /* best-effort */
    }
  });
}

export async function clearCached(chatId: number): Promise<void> {
  return withChatLock(chatId, async () => {
    try {
      await del(keyFor(chatId), STORE);
    } catch {
      /* best-effort */
    }
  });
}

/**
 * LRU trim: if more than MAX_CHATS entries, drop the oldest by lastTouchedAt.
 */
async function enforceCapacity(): Promise<void> {
  const all = await entries<string, Entry>(STORE);
  if (all.length <= MAX_CHATS) return;
  all.sort((a, b) => (a[1].lastTouchedAt ?? 0) - (b[1].lastTouchedAt ?? 0));
  const toDrop = all.slice(0, all.length - MAX_CHATS);
  await Promise.all(toDrop.map(([k]) => del(k, STORE)));
}

/**
 * Manual probe used in tests: list all cached chat IDs.
 */
export async function listCachedChats(): Promise<number[]> {
  const ks = await keys<string>(STORE);
  return ks
    .filter((k) => k.startsWith("chat:"))
    .map((k) => Number(k.slice("chat:".length)))
    .filter((n) => Number.isFinite(n));
}
