// Telegram Bot API integration for real functionality
import { Chat, Message, User } from '@/types/telegram';

class TelegramBotApiService {
  private botToken: string | null = null;
  private userId: number | null = null;

  setBotToken(token: string) {
    this.botToken = token;
  }

  async getMe(): Promise<User> {
    if (!this.botToken) throw new Error('Bot token not set');
    
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
    const data = await response.json();
    
    if (!data.ok) throw new Error(data.description);
    
    return {
      id: data.result.id,
      firstName: data.result.first_name,
      lastName: data.result.last_name,
      username: data.result.username
    };
  }

  async getUpdates(offset?: number): Promise<any[]> {
    if (!this.botToken) throw new Error('Bot token not set');
    
    const url = new URL(`https://api.telegram.org/bot${this.botToken}/getUpdates`);
    if (offset) url.searchParams.set('offset', offset.toString());
    
    const response = await fetch(url.toString());
    const data = await response.json();
    
    if (!data.ok) throw new Error(data.description);
    
    return data.result;
  }

  async sendMessage(chatId: number, text: string): Promise<Message> {
    if (!this.botToken) throw new Error('Bot token not set');
    
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
    
    const data = await response.json();
    if (!data.ok) throw new Error(data.description);
    
    return {
      id: data.result.message_id,
      chatId: data.result.chat.id,
      senderId: data.result.from.id,
      text: data.result.text,
      date: new Date(data.result.date * 1000),
      isOutgoing: true
    };
  }

  async getChatsFromUpdates(): Promise<Chat[]> {
    const updates = await this.getUpdates();
    const chatsMap = new Map<number, Chat>();
    
    updates.forEach(update => {
      if (update.message?.chat) {
        const chat = update.message.chat;
        chatsMap.set(chat.id, {
          id: chat.id,
          title: chat.type === 'private' 
            ? `${chat.first_name || ''} ${chat.last_name || ''}`.trim()
            : chat.title || 'Unknown',
          type: chat.type,
          unreadCount: 0
        });
      }
    });
    
    return Array.from(chatsMap.values());
  }
}

export const telegramBotApi = new TelegramBotApiService();