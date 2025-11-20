import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ExternalLink, Info } from 'lucide-react';

interface TelegramIntegrationInfoProps {
  onUseDemoMode: () => void;
}

export const TelegramIntegrationInfo: React.FC<TelegramIntegrationInfoProps> = ({ 
  onUseDemoMode 
}) => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="h-5 w-5" />
              Интеграция с Telegram
            </CardTitle>
            <CardDescription>
              Информация о подключении к реальному аккаунту Telegram
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertDescription>
                <strong>Важно:</strong> Полная интеграция с личным аккаунтом Telegram требует серверной части
                для обхода ограничений браузера и обеспечения безопасности.
              </AlertDescription>
            </Alert>

            <div className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Варианты реальной интеграции:</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="font-medium text-foreground">1. Telegram Bot API:</span>
                    <span>Создание бота через @BotFather для получения и отправки сообщений</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="font-medium text-foreground">2. MTProto через прокси:</span>
                    <span>Серверная прокси для работы с полным Telegram API</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="font-medium text-foreground">3. Telegram WebK:</span>
                    <span>Использование официального веб-клиента Telegram</span>
                  </li>
                </ul>
              </div>

              <div className="bg-muted p-4 rounded-lg">
                <h4 className="font-medium mb-2">Демо-режим</h4>
                <p className="text-sm text-muted-foreground mb-3">
                  Вы можете протестировать интерфейс приложения с демо-данными. 
                  Введите любой 5-значный код для входа.
                </p>
                <Button onClick={onUseDemoMode} className="w-full">
                  Использовать демо-режим
                </Button>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium">Полезные ссылки:</h4>
                <div className="flex flex-col gap-2">
                  <a 
                    href="https://my.telegram.org/apps" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Получить API ключи Telegram
                  </a>
                  <a 
                    href="https://core.telegram.org/bots" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Документация Telegram Bot API
                  </a>
                  <a 
                    href="https://docs.gramjs.org/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    GramJS (MTProto для JavaScript)
                  </a>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};