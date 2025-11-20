import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface BotTokenFormProps {
  onTokenSubmit: (token: string) => void;
  isLoading: boolean;
  error?: string;
}

export const BotTokenForm: React.FC<BotTokenFormProps> = ({ 
  onTokenSubmit, 
  isLoading, 
  error 
}) => {
  const [token, setToken] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    onTokenSubmit(token.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Настройка Telegram Bot</CardTitle>
            <CardDescription>
              Для работы с реальными сообщениями создайте бота через{' '}
              <a 
                href="https://t.me/BotFather" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                @BotFather
              </a>
              {' '}и введите токен
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="token">Bot Token</Label>
                <Input
                  id="token"
                  type="text"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Подключение...' : 'Подключить бота'}
              </Button>
            </form>
            
            <div className="mt-4 p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">
                <strong>Альтернатива:</strong> Введите любой 5-значный код (например, 12345) 
                в предыдущей форме для демонстрации интерфейса
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};