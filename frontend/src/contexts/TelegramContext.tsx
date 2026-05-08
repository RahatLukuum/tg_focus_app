import React, { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import { TelegramConfig, AuthState, Chat, Message, User, MediaType } from '@/types/telegram';
import { telegramApi } from '@/services/telegramApi';
import { appendCached } from "@/services/messageCache";

interface TelegramState {
  config?: TelegramConfig;
  auth: AuthState;
  chats: Chat[];
  contacts: Chat[];
  messages: Record<number, Message[]>;
  activeChat?: Chat;
  isLoading: boolean;
  isInitialized: boolean;
  error?: string;
  phoneCodeHash?: string;
  lastIncomingAt?: number;
  lastIncomingChatId?: number;
  /** Увеличивается при событиях, влияющих на /queue (WS, действия в очереди) — для обновления счётчика без поллинга */
  queueRevision: number;
}

type TelegramAction =
  | { type: 'SET_CONFIG'; payload: TelegramConfig }
  | { type: 'SET_AUTH_STEP'; payload: AuthState['authStep'] }
  | { type: 'SET_USER'; payload: User }
  | { type: 'SET_PHONE'; payload: string }
  | { type: 'SET_PHONE_CODE_HASH'; payload: string }
  | { type: 'SET_CHATS'; payload: Chat[] }
  | { type: 'SET_CONTACTS'; payload: Chat[] }
  | { type: 'SET_MESSAGES'; payload: { chatId: number; messages: Message[] } }
  | { type: 'PREPEND_MESSAGES'; payload: { chatId: number; messages: Message[] } }
  | { type: 'ADD_MESSAGE'; payload: Message }
  | { type: 'SET_ACTIVE_CHAT'; payload: Chat }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_INITIALIZED' }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'LOGOUT' }
  | { type: 'INCOMING'; payload: { chatId: number; at: number } }
  | { type: 'QUEUE_DIRTY' };

const initialState: TelegramState = {
  auth: {
    isAuthenticated: false,
    authStep: 'phone'
  },
  chats: [],
  contacts: [],
  messages: {},
  isLoading: false,
  isInitialized: false,
  queueRevision: 0,
};

const telegramReducer = (state: TelegramState, action: TelegramAction): TelegramState => {
  switch (action.type) {
    case 'SET_CONFIG':
      return { ...state, config: action.payload };
    case 'SET_AUTH_STEP':
      return { ...state, auth: { ...state.auth, authStep: action.payload } };
    case 'SET_USER':
      return { 
        ...state, 
        auth: { ...state.auth, user: action.payload, isAuthenticated: true, authStep: 'authenticated' }
      };
    case 'SET_PHONE':
      return { ...state, auth: { ...state.auth, phoneNumber: action.payload } };
    case 'SET_PHONE_CODE_HASH':
      return { ...state, phoneCodeHash: action.payload };
    case 'SET_CHATS':
      return { ...state, chats: action.payload };
    case 'SET_CONTACTS':
      return { ...state, contacts: action.payload };
    case 'SET_MESSAGES':
      return { 
        ...state, 
        messages: { 
          ...state.messages, 
          [action.payload.chatId]: action.payload.messages 
        }
      };
    case 'PREPEND_MESSAGES': {
      const existing = state.messages[action.payload.chatId] || [];
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.payload.chatId]: [...action.payload.messages, ...existing]
        }
      };
    }
    case 'ADD_MESSAGE':
      const chatId = action.payload.chatId;
      const existingMessages = state.messages[chatId] || [];
      return {
        ...state,
        messages: {
          ...state.messages,
          [chatId]: [...existingMessages, action.payload]
        }
      };
    case 'INCOMING':
      return { ...state, lastIncomingChatId: action.payload.chatId, lastIncomingAt: action.payload.at };
    case 'QUEUE_DIRTY':
      return { ...state, queueRevision: state.queueRevision + 1 };
    case 'SET_ACTIVE_CHAT':
      return { ...state, activeChat: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_INITIALIZED':
      return { ...state, isInitialized: true };
    case 'SET_ERROR':
      return { ...state, error: action.payload, isLoading: false };
    case 'CLEAR_ERROR':
      return { ...state, error: undefined };
    case 'LOGOUT':
      return { ...initialState };
    default:
      return state;
  }
};

interface TelegramContextType {
  state: TelegramState;
  dispatch: React.Dispatch<TelegramAction>;
  setConfig: (config: TelegramConfig) => Promise<void>;
  sendCode: (phoneNumber: string) => Promise<void>;
  signIn: (code: string) => Promise<void>;
  signInWithPassword: (password: string) => Promise<void>;
  sendMessage: (chatId: number, text: string, topicId?: number) => Promise<void>;
  sendMedia: (chatId: number, file: Blob, mediaType: MediaType, caption?: string) => Promise<void>;
  loadChats: (force?: boolean) => Promise<void>;
  loadMessages: (chatId: number) => Promise<void>;
  loadOlderMessages: (chatId: number) => Promise<void>;
  goBack: () => void;
}

const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

export const TelegramProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(telegramReducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsBackoff = useRef(1000);

  const setConfig = async (config: TelegramConfig) => {
    dispatch({ type: 'SET_CONFIG', payload: config });
    localStorage.setItem('telegram_config', JSON.stringify(config));
    
    const tryInit = async (retries = 3): Promise<void> => {
      try {
        await telegramApi.initialize(config);
        const isAuth = await telegramApi.checkAuth();
        if (isAuth) {
          const user = await telegramApi.getCurrentUser();
          dispatch({ type: 'SET_USER', payload: user });
          await loadChats(true);
          openWebSocket();
        }
      } catch (error: any) {
        if (retries > 0) {
          await new Promise(r => setTimeout(r, 2000));
          return tryInit(retries - 1);
        }
        console.error('Ошибка инициализации:', error);
      } finally {
        dispatch({ type: 'SET_INITIALIZED' });
      }
    };
    await tryInit();
  };

  const sendCode = async (phoneNumber: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'CLEAR_ERROR' });
    try {
      const result = await telegramApi.sendCode(phoneNumber);
      dispatch({ type: 'SET_PHONE', payload: phoneNumber });
      dispatch({ type: 'SET_PHONE_CODE_HASH', payload: result.phoneCodeHash });
      dispatch({ type: 'SET_AUTH_STEP', payload: 'code' });
    } catch (error: any) {
      console.error('Ошибка отправки кода:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Ошибка отправки кода' });
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const signIn = async (code: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'CLEAR_ERROR' });
    try {
      if (!state.auth.phoneNumber || !state.phoneCodeHash) {
        throw new Error('Отсутствует номер телефона или хеш кода. Повторите отправку кода.');
      }

      await telegramApi.signIn(state.auth.phoneNumber, code, state.phoneCodeHash);
      const user = await telegramApi.getCurrentUser();
      dispatch({ type: 'SET_USER', payload: user });
      await loadChats(true);
      openWebSocket();
    } catch (error: any) {
      console.error('Ошибка входа:', error);
      if (error.message === 'TWO_FACTOR_AUTH_REQUIRED') {
        dispatch({ type: 'SET_AUTH_STEP', payload: 'password' });
      } else {
        dispatch({ type: 'SET_ERROR', payload: error.message || 'Неверный код' });
      }
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const signInWithPassword = async (password: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    dispatch({ type: 'CLEAR_ERROR' });
    try {
      await telegramApi.signInWithPassword(password);
      const user = await telegramApi.getCurrentUser();
      dispatch({ type: 'SET_USER', payload: user });
      await loadChats(true);
      openWebSocket();
    } catch (error: any) {
      console.error('Ошибка входа с паролем:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Неверный пароль' });
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const sendMessage = async (chatId: number, text: string, topicId?: number) => {
    try {
      const message = await telegramApi.sendMessage(chatId, text, topicId);
      dispatch({ type: 'ADD_MESSAGE', payload: message });
    } catch (error: any) {
      console.error('Ошибка отправки сообщения:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Ошибка отправки сообщения' });
    }
  };

  const sendMedia = async (chatId: number, file: Blob, mediaType: MediaType, caption?: string) => {
    try {
      const message = await telegramApi.sendMedia(chatId, file, mediaType, caption);
      dispatch({ type: 'ADD_MESSAGE', payload: message });
    } catch (error: any) {
      console.error('Ошибка отправки медиа:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Ошибка отправки медиа' });
      throw error;
    }
  };

  const loadChats = async (force: boolean = false) => {
    if (!force && !state.auth.isAuthenticated) return;
    
    dispatch({ type: 'SET_LOADING', payload: true });
    try {
      const bootstrap = await telegramApi.getBootstrap();
      dispatch({ type: 'SET_CHATS', payload: bootstrap.chats });
      dispatch({ type: 'SET_CONTACTS', payload: bootstrap.contacts });
    } catch (error: any) {
      console.error('Ошибка загрузки чатов:', error);
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const loadMessages = async (chatId: number) => {
    try {
      const messages = await telegramApi.getMessages(chatId);
      dispatch({ type: 'SET_MESSAGES', payload: { chatId, messages } });
    } catch (error: any) {
      console.error('Ошибка загрузки сообщений:', error);
    }
  };

  const loadOlderMessages = async (chatId: number) => {
    try {
      const existing = state.messages[chatId] || [];
      const firstId = existing[0]?.id;
      if (!firstId) return; // нечего догружать
      const older = await telegramApi.getOlderMessages(chatId, firstId);
      if (older.length > 0) {
        dispatch({ type: 'PREPEND_MESSAGES', payload: { chatId, messages: older } });
      }
    } catch (error: any) {
      console.error('Ошибка догрузки сообщений:', error);
    }
  };

  const goBack = () => {
    dispatch({ type: 'CLEAR_ERROR' });
    switch (state.auth.authStep) {
      case 'code':
        dispatch({ type: 'SET_AUTH_STEP', payload: 'phone' });
        break;
      case 'password':
        dispatch({ type: 'SET_AUTH_STEP', payload: 'code' });
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const savedConfig = localStorage.getItem('telegram_config');
    if (savedConfig) {
      try {
        const config = JSON.parse(savedConfig);
        setConfig(config);
      } catch (error) {
        console.error('Ошибка загрузки конфигурации:', error);
      }
    } else {
      // нет сохраненной конфигурации — всё равно пробуем восстановить сессию
      // сессия Pyrogram хранится на бэке, поэтому просто инициализируем и спрашиваем /me
      setConfig({ apiId: 0 as any, apiHash: '' as any });
    }
  }, []);

  const onWsEvent = (evt: any) => {
    if (evt?.type === 'queue_update' && typeof evt.chat_id === 'number') {
      dispatch({ type: 'INCOMING', payload: { chatId: evt.chat_id, at: Date.now() } });
      dispatch({ type: 'QUEUE_DIRTY' });
      return;
    }
    if (evt?.type === 'message' && typeof evt.chat_id === 'number' && evt.message) {
      const m = evt.message;
      const mapped: Message = {
        id: m.id,
        chatId: evt.chat_id,
        senderId: m.from_user_id || 0,
        senderName: m.from_user_name || undefined,
        text: m.text || '',
        date: m.date ? new Date(m.date * 1000) : new Date(),
        isOutgoing: !!m.outgoing,
      };
      if (m.media_type) {
        mapped.mediaType = m.media_type;
        if (m.media_url) {
          mapped.mediaUrl = telegramApi.getMediaUrl(m.media_url);
        }
        if (m.file_name) mapped.fileName = m.file_name;
        if (m.duration != null) mapped.duration = m.duration;
      }
      dispatch({ type: 'ADD_MESSAGE', payload: mapped });
      // Persist new message to IndexedDB cache (best-effort, no await).
      void appendCached(mapped.chatId, [mapped]).catch(() => {});
      if (!mapped.isOutgoing) {
        dispatch({ type: 'INCOMING', payload: { chatId: mapped.chatId, at: Date.now() } });
      }
    }
  };

  const openWebSocket = () => {
    if (wsReconnectTimer.current) { clearTimeout(wsReconnectTimer.current); wsReconnectTimer.current = null; }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

    const ws = telegramApi.connectWebSocket(onWsEvent);

    ws.addEventListener('open', () => {
      wsBackoff.current = 1000;
    });

    ws.addEventListener('close', () => {
      wsRef.current = null;
      wsReconnectTimer.current = setTimeout(() => {
        wsBackoff.current = Math.min(wsBackoff.current * 2, 15000);
        openWebSocket();
      }, wsBackoff.current);
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });

    wsRef.current = ws;
  };

  useEffect(() => {
    return () => {
      if (wsReconnectTimer.current) clearTimeout(wsReconnectTimer.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
    };
  }, []);

  const contextValue: TelegramContextType = {
    state,
    dispatch,
    setConfig,
    sendCode,
    signIn,
    signInWithPassword,
    sendMessage,
    sendMedia,
    loadChats,
    loadMessages,
    loadOlderMessages,
    goBack
  };

  return (
    <TelegramContext.Provider value={contextValue}>
      {children}
    </TelegramContext.Provider>
  );
};

export const useTelegram = () => {
  const context = useContext(TelegramContext);
  if (!context) {
    throw new Error('useTelegram must be used within a TelegramProvider');
  }
  return context;
};