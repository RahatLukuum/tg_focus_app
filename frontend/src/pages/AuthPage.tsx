import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { useTelegram } from '@/contexts/TelegramContext';

const AuthPage = () => {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const { sendCode, signIn, signInWithPassword, state, loadChats } = useTelegram();
  const isLoading = state.isLoading;
  const error = state.error;
  const authStep = state.auth.authStep;
  const showPasswordStep = useMemo(() => authStep === 'password', [authStep]);

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;
    try {
      await sendCode(phone.trim());
      setStep('code');
    } catch (_) {}
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      await signIn(code.trim());
      navigate('/home');
    } catch (_) {}
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    try {
      await signInWithPassword(password.trim());
      navigate('/home');
    } catch (_) {}
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        {/* Кнопка входа по сохраненной сессии */}
        <div className="mb-4">
          <Button
            variant="secondary"
            className="w-full"
            onClick={async () => {
              try {
                // просто попробуем сходить за /me через контекстную инициализацию
                await loadChats(); // если уже авторизованы, подтянет чаты
                if (state.auth.isAuthenticated) {
                  navigate('/home');
                } else {
                  // триггерим стандартный setConfig->/me в провайдере
                  window.location.reload();
                }
              } catch {}
            }}
          >
            Войти (по сохраненной сессии)
          </Button>
        </div>

        {showPasswordStep ? (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-semibold">Пароль 2FA</h1>
              <p className="text-muted-foreground mt-2">Введите пароль двухфакторной аутентификации</p>
            </div>
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <Input
                type="password"
                placeholder="Пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="text-center text-lg"
                autoFocus
              />
              {error && (
                <p className="text-sm text-red-600 text-center">{error}</p>
              )}
              <Button type="submit" className="w-full" disabled={!password.trim() || isLoading}>
                {isLoading ? 'Входим…' : 'Войти'}
              </Button>
            </form>
          </div>
        ) : step === 'phone' ? (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-semibold">Вход в аккаунт</h1>
              <p className="text-muted-foreground mt-2">Введите номер телефона</p>
            </div>
            <form onSubmit={handlePhoneSubmit} className="space-y-4">
              <Input
                type="tel"
                placeholder="+7 (999) 123-45-67"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="text-center text-lg"
                autoFocus
              />
              {error && (
                <p className="text-sm text-red-600 text-center">{error}</p>
              )}
              <Button type="submit" className="w-full" disabled={!phone.trim() || isLoading}>
                {isLoading ? 'Отправляем…' : 'Получить код'}
              </Button>
            </form>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-semibold">Код подтверждения</h1>
              <p className="text-muted-foreground mt-2">
                Введите код, отправленный на {phone}
              </p>
            </div>
            <form onSubmit={handleCodeSubmit} className="space-y-4">
              <Input
                type="text"
                placeholder="12345"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="text-center text-2xl tracking-widest"
                maxLength={5}
                autoFocus
              />
              {error && (
                <p className="text-sm text-red-600 text-center">{error}</p>
              )}
              <div className="space-y-2">
                <Button type="submit" className="w-full" disabled={!code.trim() || isLoading}>
                  {isLoading ? 'Проверяем…' : 'Войти'}
                </Button>
                <Button 
                  type="button" 
                  variant="ghost" 
                  className="w-full"
                  onClick={() => setStep('phone')}
                >
                  Назад
                </Button>
              </div>
            </form>
          </div>
        )}
      </Card>
    </div>
  );
};

export default AuthPage;