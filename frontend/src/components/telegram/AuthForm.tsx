import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft } from 'lucide-react';
import { useTelegram } from '@/contexts/TelegramContext';
import { TelegramConfig } from '@/types/telegram';
import { TelegramIntegrationInfo } from './TelegramIntegrationInfo';

export const AuthForm: React.FC = () => {
  const { state, setConfig, sendCode, signIn, signInWithPassword, goBack } = useTelegram();
  const [showIntegrationInfo, setShowIntegrationInfo] = useState(false);
  const [formData, setFormData] = useState({
    apiId: '',
    apiHash: '',
    phoneNumber: '',
    code: '',
    password: ''
  });

  if (showIntegrationInfo) {
    return (
      <TelegramIntegrationInfo 
        onUseDemoMode={() => setShowIntegrationInfo(false)} 
      />
    );
  }

  const handleConfigSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.apiId || !formData.apiHash) return;

    const config: TelegramConfig = {
      apiId: parseInt(formData.apiId),
      apiHash: formData.apiHash
    };

    await setConfig(config);
  };

  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.phoneNumber) return;
    sendCode(formData.phoneNumber);
  };

  const handleCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.code) return;
    signIn(formData.code);
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.password) return;
    signInWithPassword(formData.password);
  };

  const renderConfigForm = () => (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Настройка Telegram API</CardTitle>
        <CardDescription>
          Введите API ID и API Hash, полученные на{' '}
          <a 
            href="https://my.telegram.org" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            my.telegram.org
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleConfigSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="apiId">API ID</Label>
            <Input
              id="apiId"
              type="number"
              value={formData.apiId}
              onChange={(e) => setFormData({ ...formData, apiId: e.target.value })}
              placeholder="Введите API ID"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiHash">API Hash</Label>
            <Input
              id="apiHash"
              type="text"
              value={formData.apiHash}
              onChange={(e) => setFormData({ ...formData, apiHash: e.target.value })}
              placeholder="Введите API Hash"
              required
            />
          </div>
          <Button type="submit" className="w-full">
            Сохранить настройки
          </Button>
        </form>
        
        <div className="mt-4 pt-4 border-t">
          <Button 
            variant="outline" 
            className="w-full" 
            onClick={() => setShowIntegrationInfo(true)}
          >
            Как подключить реальный аккаунт?
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  const renderPhoneForm = () => (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Вход в Telegram</CardTitle>
        <CardDescription>
          Введите номер телефона для получения кода подтверждения
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handlePhoneSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone">Номер телефона</Label>
            <Input
              id="phone"
              type="tel"
              value={formData.phoneNumber}
              onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value })}
              placeholder="+7 (xxx) xxx-xx-xx"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={state.isLoading}>
            {state.isLoading ? 'Отправка...' : 'Отправить код'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );

  const renderCodeForm = () => (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={goBack}
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <CardTitle>Подтверждение входа</CardTitle>
        </div>
        <CardDescription>
          Введите код подтверждения, отправленный на номер {state.auth.phoneNumber}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleCodeSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">Код подтверждения</Label>
            <Input
              id="code"
              type="text"
              value={formData.code}
              onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              placeholder="Введите код (например, 12345)"
              maxLength={5}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={state.isLoading}>
            {state.isLoading ? 'Проверка...' : 'Войти'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );

  const renderPasswordForm = () => (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={goBack}
            className="h-8 w-8"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <CardTitle>Двухфакторная аутентификация</CardTitle>
        </div>
        <CardDescription>
          Введите пароль для двухфакторной аутентификации
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              placeholder="Введите пароль"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={state.isLoading}>
            {state.isLoading ? 'Проверка...' : 'Войти'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4">
        {state.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        
        {!state.config && renderConfigForm()}
        {state.config && state.auth.authStep === 'phone' && renderPhoneForm()}
        {state.config && state.auth.authStep === 'code' && (
          <>
            {renderCodeForm()}
            <div className="mt-4 p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">
                <strong>Демо-режим:</strong> Введите любой 5-значный код (например, 12345) 
                для демонстрации интерфейса. Реальные SMS не отправляются.
              </p>
            </div>
          </>
        )}
        {state.config && state.auth.authStep === 'password' && renderPasswordForm()}
      </div>
    </div>
  );
};