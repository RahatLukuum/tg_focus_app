import { TelegramConfig, User, Chat, Message, MediaType } from '@/types/telegram';

const ACTIVE_ACCOUNT_KEY = 'tg_active_account';

class TelegramApiService {
  private baseUrl: string;
  private config: TelegramConfig | null = null;
  private isAuthenticated: boolean = false;
  private currentUser: User | null = null;
  private lastPhone: string | null = null;
  private lastCode: string | null = null;
  /** Номер аккаунта для мульти-клиента на бэке (query/body `account`) */
  private activeAccount: string | null = null;

  constructor() {
    const envBase = (import.meta as any).env?.VITE_API_BASE_URL as string | undefined;
    // Single source of truth: env with default to your server
    this.baseUrl = (envBase && envBase.trim()) || 'http://185.250.149.23:8080';
    try {
      const saved = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
      if (saved) this.activeAccount = saved;
    } catch {
      /* ignore */
    }
    try { console.log('[telegramApi] baseUrl =', this.baseUrl); } catch {}
  }

  private setActiveAccount(phone: string | null) {
    this.activeAccount = phone;
    try {
      if (phone) localStorage.setItem(ACTIVE_ACCOUNT_KEY, phone);
      else localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Добавляет ?account= для эндпоинтов не /auth */
  private withAccountQuery(path: string): string {
    if (!this.activeAccount || path.startsWith('/auth')) return path;
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}account=${encodeURIComponent(this.activeAccount)}`;
  }

  async initialize(config: TelegramConfig) {
    this.config = config;
    try {
      const me = await this.fetchJson('/me');
      if (me.authorized && me.me) {
        this.currentUser = {
          id: me.me.id,
          firstName: me.me.first_name,
          lastName: undefined,
          username: me.me.username,
        };
        this.isAuthenticated = true;
      }
    } catch (_) {
      // ignore
    }
  }

  async sendCode(phoneNumber: string): Promise<{ phoneCodeHash: string }> {
    const normalized = TelegramApiService.normalizePhone(phoneNumber);
    const res = await this.fetchJson('/auth/send_code', {
      method: 'POST',
      body: JSON.stringify({ phone: normalized })
    });
    // Сохраняем phone_code_hash от сервера, если есть
    const hash = res.phone_code_hash || res.phoneCodeHash || res.phoneCode || 'local_' + Date.now();
    return { phoneCodeHash: hash };
  }

  async signIn(phoneNumber: string, phoneCode: string, _phoneCodeHash: string): Promise<any> {
    if (!/^\d{5}$/.test(phoneCode)) {
      throw new Error('Код должен содержать 5 цифр');
    }
    const normalized = TelegramApiService.normalizePhone(phoneNumber);
    this.lastPhone = normalized;
    this.lastCode = phoneCode;
    try {
      const res = await this.fetchJson('/auth/sign_in', {
        method: 'POST',
        body: JSON.stringify({ phone: normalized, code: phoneCode })
      });
      if (res.ok) {
        // доверяем ответу бэкенда, если он вернул me
        if (res.me && res.me.id) {
          this.setActiveAccount(normalized);
          this.currentUser = {
            id: res.me.id,
            firstName: res.me.first_name,
            lastName: undefined,
            username: res.me.username,
          };
          this.isAuthenticated = true;
          return { user: this.currentUser };
        }
        // fallback: спросим /me
        const me = await this.fetchJson('/me');
        if (me.authorized && me.me) {
          this.setActiveAccount(normalized);
          this.currentUser = {
            id: me.me.id,
            firstName: me.me.first_name,
            lastName: undefined,
            username: me.me.username,
          };
          this.isAuthenticated = true;
          return { user: this.currentUser };
        }
      }
      throw new Error('Не удалось войти');
    } catch (e: any) {
      const msg = typeof e.message === 'string' ? e.message : '';
      if (msg.includes('Two-factor password required')) {
        throw new Error('TWO_FACTOR_AUTH_REQUIRED');
      }
      throw e;
    }
  }

  async signInWithPassword(password: string): Promise<any> {
    if (!this.lastPhone || !this.lastCode) {
      throw new Error('Повторите вход');
    }
    const res = await this.fetchJson('/auth/sign_in', {
      method: 'POST',
      body: JSON.stringify({ phone: this.lastPhone, code: this.lastCode, password })
    });
    if (res.ok && res.me && res.me.id) {
      // Не вызываем /me без account — на бэке это другой клиент (LOGIN), не сессия по номеру
      this.setActiveAccount(this.lastPhone);
      this.currentUser = {
        id: res.me.id,
        firstName: res.me.first_name,
        lastName: undefined,
        username: res.me.username,
      };
      this.isAuthenticated = true;
      return { user: this.currentUser };
    }
    if (res.ok) {
      const me = await this.fetchJson('/me');
      if (me.authorized && me.me) {
        this.setActiveAccount(this.lastPhone);
        this.currentUser = {
          id: me.me.id,
          firstName: me.me.first_name,
          lastName: undefined,
          username: me.me.username,
        };
        this.isAuthenticated = true;
        return { user: this.currentUser };
      }
    }
    throw new Error('Не удалось войти');
  }

  async getCurrentUser(): Promise<User> {
    if (!this.isAuthenticated || !this.currentUser) {
      throw new Error('Пользователь не авторизован');
    }
    return this.currentUser;
  }

  async getChats(): Promise<Chat[]> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    const res = await this.fetchJson('/dialogs');
    const chats: Chat[] = (res.dialogs || [])
      .filter((d: any) => {
        const t = (d.type || '').toString().toLowerCase();
        return t === 'private';
      })
      .map((d: any) => ({
      id: d.chat_id,
      title: d.title || 'Без названия',
      type: d.type as Chat['type'],
      unreadCount: d.unread_count || 0,
      lastMessage: d.last_message_text
        ? {
            id: Date.now(),
            chatId: d.chat_id,
            senderId: 0,
            text: d.last_message_text,
            date: new Date(),
            isOutgoing: false,
          }
        : undefined,
    }));
    return chats;
  }

  async getContacts(): Promise<Chat[]> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    const res = await this.fetchJson('/contacts');
    return (res.contacts || []).map((c: any) => ({
      id: c.chat_id,
      title: c.title || 'Без названия',
      type: 'private' as Chat['type'],
      unreadCount: 0,
    }));
  }

  private mapMessage(m: any, chatId: number): Message {
    const msg: Message = {
      id: m.id,
      chatId,
      senderId: m.from_user_id || 0,
      text: m.text || '',
      date: m.date ? new Date(m.date * 1000) : new Date(),
      isOutgoing: !!m.outgoing,
    };
    if (m.media_type) {
      msg.mediaType = m.media_type as MediaType;
      msg.mediaUrl = m.media_url ? this.baseUrl + this.withAccountQuery(m.media_url) : undefined;
      if (m.file_name) msg.fileName = m.file_name;
      if (m.duration != null) msg.duration = m.duration;
    }
    return msg;
  }

  async getMessages(chatId: number, limit: number = 100): Promise<Message[]> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    const res = await this.fetchJson(`/messages?chat_id=${encodeURIComponent(chatId)}&limit=${limit}`);
    return (res.messages || []).map((m: any) => this.mapMessage(m, res.chat_id));
  }

  async getOlderMessages(chatId: number, beforeId: number, limit: number = 100): Promise<Message[]> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    const res = await this.fetchJson(`/messages?chat_id=${encodeURIComponent(chatId)}&limit=${limit}&before_id=${beforeId}`);
    return (res.messages || []).map((m: any) => this.mapMessage(m, res.chat_id));
  }

  async sendMessage(chatId: number, text: string): Promise<Message> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    await this.fetchJson('/send_message', {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const currentUser = await this.getCurrentUser();
    return {
      id: Date.now(),
      chatId,
      senderId: currentUser.id,
      text,
      date: new Date(),
      isOutgoing: true,
    };
  }

  async sendMedia(chatId: number, file: Blob, mediaType: MediaType, caption?: string): Promise<Message> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('media_type', mediaType);
    form.append('caption', caption || '');
    if (this.activeAccount) form.append('account', this.activeAccount);
    const ext = mediaType === 'photo' ? '.jpg' : mediaType === 'video' ? '.mp4' : mediaType === 'voice' ? '.ogg' : '.bin';
    form.append('file', file, `upload${ext}`);
    const url = this.baseUrl + this.withAccountQuery('/send_media');
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || 'Upload failed');
    }
    const currentUser = await this.getCurrentUser();
    return {
      id: Date.now(),
      chatId,
      senderId: currentUser.id,
      text: caption || '',
      date: new Date(),
      isOutgoing: true,
      mediaType,
    };
  }

  getMediaUrl(path: string): string {
    return this.baseUrl + this.withAccountQuery(path);
  }

  async generateReply(chatId: number, prompt?: string): Promise<string> {
    if (!this.isAuthenticated) throw new Error('Пользователь не авторизован');
    const res = await this.fetchJson('/generate_reply', {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId, prompt: prompt || '' }),
    });
    return res.reply || '';
  }

  async resolveContact(params: { userId?: number; phone?: string; username?: string }): Promise<{ userId: number; chatId: number }> {
    const res = await this.fetchJson('/resolve_contact', {
      method: 'POST',
      body: JSON.stringify({ user_id: params.userId, phone: params.phone, username: params.username })
    });
    return { userId: res.user_id, chatId: res.chat_id };
  }

  async getQueue(): Promise<number[]> {
    const res = await this.fetchJson('/queue');
    return Array.isArray(res.queue) ? res.queue : [];
  }

  async queueAction(chatId: number, action: 'done' | 'postpone' | 'task'): Promise<number[]> {
    const res = await this.fetchJson('/queue/action', {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId, action })
    });
    return Array.isArray(res.queue) ? res.queue : [];
  }

  async isConnected(): Promise<boolean> {
    try {
      const me = await this.fetchJson('/me');
      return !!me.authorized;
    } catch {
      return false;
    }
  }

  async logout() {
    this.isAuthenticated = false;
    this.currentUser = null;
    this.config = null;
    this.lastPhone = null;
    this.lastCode = null;
    this.setActiveAccount(null);
  }

  async checkAuth(): Promise<boolean> {
    return this.isConnected();
  }

  connectWebSocket(onEvent: (evt: any) => void): WebSocket {
    let wsUrl = '';
    try {
      const u = new URL(this.baseUrl);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.pathname = (u.pathname.replace(/\/$/, '')) + '/ws';
      wsUrl = u.toString();
    } catch {
      wsUrl = this.baseUrl.replace('http', 'ws') + '/ws';
    }
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch (_) {}
    };
    return ws;
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<any> {
    const attempt = async (base: string) => {
      const pathWithAcc = this.withAccountQuery(path);
      let mergedInit = init;
      if (
        this.activeAccount &&
        !path.startsWith('/auth') &&
        init?.body &&
        typeof init.body === 'string'
      ) {
        try {
          const o = JSON.parse(init.body);
          if (typeof o === 'object' && o !== null && !('account' in o)) {
            mergedInit = {
              ...init,
              body: JSON.stringify({ ...o, account: this.activeAccount }),
            };
          }
        } catch {
          /* keep init */
        }
      }
      const url = base + pathWithAcc;
      // Tauri macOS: allow cleartext to specific server via ATS exception; here just log for diagnostics
      try { console.debug('[fetch]', url); } catch {}
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...mergedInit,
      });
      if (!res.ok) {
        let detail = 'Request failed';
        try {
          const data = await res.clone().json();
          detail = (data && (data.detail || data.error)) || JSON.stringify(data);
        } catch {
          try {
            const text = await res.clone().text();
            if (text) detail = `[${res.status}] ${text}`;
          } catch {}
        }
        throw new Error(detail);
      }
      try {
        return await res.json();
      } catch {
        return {};
      }
    };

      return await attempt(this.baseUrl);
  }

  // removed togglePort fallback to avoid unintended base switches

  private static normalizePhone(input: string): string {
    const digits = (input || '').replace(/\D+/g, '');
    if (!digits) return input;
    // RU heuristics: 11 digits starting with 8 or 7 -> +7..........
    if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
      return '+7' + digits.slice(1);
    }
    if (digits.length === 10) {
      return '+7' + digits;
    }
    if (digits.startsWith('7')) {
      return '+' + digits;
    }
    // default: add plus
    return input.startsWith('+') ? input : ('+' + digits);
  }
}

export const telegramApi = new TelegramApiService();