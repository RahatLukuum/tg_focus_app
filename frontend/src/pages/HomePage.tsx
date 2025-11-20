import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MessageSquare, Users, LogOut } from 'lucide-react';

const HomePage = () => {
  const navigate = useNavigate();

  const handleLogout = () => {
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <div className="space-y-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Главная</h1>
          </div>
          
          <div className="space-y-4">
            <Button 
              className="w-full h-16 text-lg"
              onClick={() => navigate('/message', { state: { refresh: true } })}
            >
              <MessageSquare className="w-6 h-6 mr-3" />
              Написать сообщение
            </Button>
            
            <Button 
              className="w-full h-16 text-lg"
              onClick={() => navigate('/queue')}
            >
              <Users className="w-6 h-6 mr-3" />
              Разбор очереди
            </Button>
          </div>

          <Button 
            variant="ghost" 
            className="w-full"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Выйти
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default HomePage;