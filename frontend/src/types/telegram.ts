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
  isForum?: boolean;
  isArchived?: boolean;
}

export interface Topic {
  topicId: number;
  title: string;
  iconColor?: number;
  iconEmojiId?: string | null;
  unreadCount: number;
  lastMessageText: string | null;
}

export type MediaType = 'photo' | 'video' | 'voice' | 'video_note' | 'audio' | 'document';

export interface Message {
  id: number;
  chatId: number;
  senderId: number;
  senderName?: string;
  text: string;
  date: Date;
  isOutgoing: boolean;
  replyToMessage?: Message;
  edited?: boolean;
  mediaType?: MediaType;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  topicId?: number;
}

export interface AuthState {
  isAuthenticated: boolean;
  phoneNumber?: string;
  user?: User;
  authStep: 'phone' | 'code' | 'password' | 'authenticated';
}
