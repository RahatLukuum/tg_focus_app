import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { telegramApi } from "@/services/telegramApi";
import type { Topic } from "@/types/telegram";

export default function TopicsPage() {
  const navigate = useNavigate();
  const { chatId: chatIdRaw } = useParams();
  const chatId = parseInt(chatIdRaw || "0", 10);
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState<string>("");

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    (async () => {
      try {
        const [info, t] = await Promise.all([
          telegramApi.getChatInfo(chatId).catch(() => null),
          telegramApi.getTopics(chatId),
        ]);
        if (cancelled) return;
        if (info) setChatTitle(info.title);
        setTopics(t);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Ошибка загрузки тем");
      }
    })();
    return () => { cancelled = true; };
  }, [chatId]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-10 bg-background border-b border-border p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/message")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="font-semibold truncate">{chatTitle || "Темы"}</h1>
      </div>

      <div className="p-4 space-y-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {topics === null && !error && <p className="text-sm text-muted-foreground">Загрузка...</p>}
        {topics && topics.length === 0 && (
          <p className="text-sm text-muted-foreground">В этой группе пока нет тем.</p>
        )}
        {topics?.map((t) => (
          <Card
            key={t.topicId}
            className="p-3 cursor-pointer hover:bg-muted/30 transition"
            onClick={() => navigate(`/chat/${chatId}?topic_id=${t.topicId}`)}
          >
            <div className="flex items-start gap-3">
              <div
                className="h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold text-white"
                style={{ backgroundColor: t.iconColor ? `#${t.iconColor.toString(16).padStart(6, "0")}` : "#7e8a98" }}
              >
                {t.title[0] || "#"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="font-medium truncate">{t.title}</p>
                  {t.unreadCount > 0 && (
                    <span className="ml-2 text-[10px] font-bold rounded-full bg-primary text-primary-foreground px-1.5 py-0.5">
                      {t.unreadCount}
                    </span>
                  )}
                </div>
                {t.lastMessageText && (
                  <p className="text-xs text-muted-foreground truncate">{t.lastMessageText}</p>
                )}
              </div>
              <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
