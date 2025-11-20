export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  test?: boolean;
}

export interface User {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  phone?: string;
  profilePhoto?: string;
}

export interface Chat {
  id: number;
  title: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  photo?: string;
  unreadCount?: number;
  lastMessage?: Message;
  isOnline?: boolean;
}

export interface Message {
  id: number;
  chatId: number;
  senderId: number;
  text: string;
  date: Date;
  isOutgoing: boolean;
  replyToMessage?: Message;
  edited?: boolean;
}

export interface AuthState {
  isAuthenticated: boolean;
  phoneNumber?: string;
  user?: User;
  authStep: 'phone' | 'code' | 'password' | 'authenticated';
}