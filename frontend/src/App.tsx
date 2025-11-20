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

const queryClient = new QueryClient();

const isTauri = typeof (globalThis as any).__TAURI__ !== 'undefined' ||
  Boolean((import.meta as any).env?.VITE_TAURI) ||
  String((import.meta as any).env?.BASE_URL || '').startsWith('.') ;

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
              <Route path="/chat/:chatId" element={<ChatPage />} />
            </Routes>
          </HashRouter>
        ) : (
          <BrowserRouter basename={(import.meta as any).env?.BASE_URL || "/"}>
            <Routes>
              <Route path="/" element={<AuthPage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/message" element={<MessagePage />} />
              <Route path="/chat/:chatId" element={<ChatPage />} />
            </Routes>
          </BrowserRouter>
        )}
      </TooltipProvider>
    </TelegramProvider>
  </QueryClientProvider>
);

export default App;
