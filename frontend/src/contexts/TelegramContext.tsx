import React, { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import { TelegramConfig, AuthState, Chat, Message, User } from '@/types/telegram';
import { telegramApi } from '@/services/telegramApi';

interface TelegramState {
  config?: TelegramConfig;
  auth: AuthState;
  chats: Chat[];
  messages: Record<number, Message[]>;
  activeChat?: Chat;
  isLoading: boolean;
  error?: string;
  phoneCodeHash?: string;
  lastIncomingAt?: number;
  lastIncomingChatId?: number;
}

type TelegramAction =
  | { type: 'SET_CONFIG'; payload: TelegramConfig }
  | { type: 'SET_AUTH_STEP'; payload: AuthState['authStep'] }
  | { type: 'SET_USER'; payload: User }
  | { type: 'SET_PHONE'; payload: string }
  | { type: 'SET_PHONE_CODE_HASH'; payload: string }
  | { type: 'SET_CHATS'; payload: Chat[] }
  | { type: 'SET_MESSAGES'; payload: { chatId: number; messages: Message[] } }
  | { type: 'PREPEND_MESSAGES'; payload: { chatId: number; messages: Message[] } }
  | { type: 'ADD_MESSAGE'; payload: Message }
  | { type: 'SET_ACTIVE_CHAT'; payload: Chat }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'LOGOUT' }
  | { type: 'INCOMING'; payload: { chatId: number; at: number } };

const initialState: TelegramState = {
  auth: {
    isAuthenticated: false,
    authStep: 'phone'
  },
  chats: [],
  messages: {},
  isLoading: false
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
    case 'SET_ACTIVE_CHAT':
      return { ...state, activeChat: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
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
  sendMessage: (chatId: number, text: string) => Promise<void>;
  loadChats: () => Promise<void>;
  loadMessages: (chatId: number) => Promise<void>;
  loadOlderMessages: (chatId: number) => Promise<void>;
  goBack: () => void;
}

const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

export const TelegramProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(telegramReducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  const setConfig = async (config: TelegramConfig) => {
    dispatch({ type: 'SET_CONFIG', payload: config });
    localStorage.setItem('telegram_config', JSON.stringify(config));
    
    try {
      await telegramApi.initialize(config);
      
      // Check if already authenticated
      const isAuth = await telegramApi.checkAuth();
      if (isAuth) {
        const user = await telegramApi.getCurrentUser();
        dispatch({ type: 'SET_USER', payload: user });
        await loadChats();
        // open websocket for updates
        openWebSocket();
      }
    } catch (error: any) {
      console.error('Ошибка инициализации:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message });
    }
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
      await loadChats();
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
      await loadChats();
      openWebSocket();
    } catch (error: any) {
      console.error('Ошибка входа с паролем:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Неверный пароль' });
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const sendMessage = async (chatId: number, text: string) => {
    try {
      const message = await telegramApi.sendMessage(chatId, text);
      dispatch({ type: 'ADD_MESSAGE', payload: message });
    } catch (error: any) {
      console.error('Ошибка отправки сообщения:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Ошибка отправки сообщения' });
    }
  };

  const loadChats = async () => {
    if (!state.auth.isAuthenticated) return;
    
    dispatch({ type: 'SET_LOADING', payload: true });
    try {
      const chats = await telegramApi.getChats();
      dispatch({ type: 'SET_CHATS', payload: chats });
    } catch (error: any) {
      console.error('Ошибка загрузки чатов:', error);
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Ошибка загрузки чатов' });
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
      dispatch({ type: 'SET_ERROR', payload: error.message || 'Ошибка загрузки сообщений' });
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

  const openWebSocket = () => {
    if (wsRef.current) return;
    wsRef.current = telegramApi.connectWebSocket((evt) => {
      if (evt?.type === 'message' && typeof evt.chat_id === 'number' && evt.message) {
        const mapped: Message = {
          id: evt.message.id,
          chatId: evt.chat_id,
          senderId: evt.message.from_user_id || 0,
          text: evt.message.text || '',
          date: evt.message.date ? new Date(evt.message.date * 1000) : new Date(),
          isOutgoing: !!evt.message.outgoing,
        };
        dispatch({ type: 'ADD_MESSAGE', payload: mapped });
        // сигнализируем страницам о новом входящем сообщении в конкретный чат
        if (!mapped.isOutgoing) {
          dispatch({ type: 'INCOMING', payload: { chatId: mapped.chatId, at: Date.now() } });
        }
      }
    });
  };

  useEffect(() => {
    return () => {
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