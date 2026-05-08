import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route } from "react-router-dom";
import { TelegramProvider } from "@/contexts/TelegramContext";
import AuthPage from "./pages/AuthPage";
import HomePage from "./pages/HomePage";
import QueuePage from "./pages/QueuePage";
import MessagePage from "./pages/MessagePage";
import ChatPage from "./pages/ChatPage";
import TodoPage from "./pages/TodoPage";
import TopicsPage from "@/pages/TopicsPage";

const queryClient = new QueryClient();

const isTauri = typeof (globalThis as any).__TAURI__ !== 'undefined' ||
  Boolean((import.meta as any).env?.VITE_TAURI) ||
  String((import.meta as any).env?.BASE_URL || '').startsWith('.') ;

/** basename для BrowserRouter: должен совпадать с тем, где реально лежит SPA (корень nginx или /app/ на бэке). */
function webRouterBasename(): string {
  const forced = (import.meta as any).env?.VITE_ROUTER_BASE as string | undefined;
  if (typeof forced === 'string' && forced.trim()) {
    const t = forced.trim().replace(/\/+$/, '') || '/';
    return t.startsWith('/') ? t : `/${t}`;
  }
  const raw = String((import.meta as any).env?.BASE_URL ?? '/');
  const trimmed = raw.replace(/\/+$/, '') || '/';
  return trimmed === '' ? '/' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TelegramProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        {isTauri ? (
          <HashRouter>
            <Routes>
              <Route path="/" element={<AuthPage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/message" element={<MessagePage />} />
              <Route path="/chat/:chatId/topics" element={<TopicsPage />} />
              <Route path="/chat/:chatId" element={<ChatPage />} />
              <Route path="/todo" element={<TodoPage />} />
            </Routes>
          </HashRouter>
        ) : (
          <BrowserRouter basename={webRouterBasename()}>
            <Routes>
              <Route path="/" element={<AuthPage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/message" element={<MessagePage />} />
              <Route path="/chat/:chatId/topics" element={<TopicsPage />} />
              <Route path="/chat/:chatId" element={<ChatPage />} />
              <Route path="/todo" element={<TodoPage />} />
            </Routes>
          </BrowserRouter>
        )}
      </TooltipProvider>
    </TelegramProvider>
  </QueryClientProvider>
);

export default App;
