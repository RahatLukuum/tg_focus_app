import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tasksApi } from "@/services/tasksApi";
import { toast } from "sonner";

type Props = {
  open: boolean;
  chatId: number;
  chatTitle: string;
  onClose: () => void;
  /** Called after successful task creation. The boolean indicates whether
   * the user requested also-remove-from-queue. */
  onCreated: (alsoRemove: boolean) => void;
};

export function TaskFromChatForm({ open, chatId, chatTitle, onClose, onCreated }: Props) {
  const [text, setText] = useState<string>(`Ответить ${chatTitle}`);
  const [alsoRemove, setAlsoRemove] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  if (!open) return null;

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await tasksApi.create({
        text: trimmed,
        chat_id: chatId,
        chat_title: chatTitle,
      });
      toast.success("Задача создана");
      onCreated(alsoRemove);
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Не удалось создать задачу");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-lg max-w-md w-full p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold">Новая задача</h3>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          placeholder="Текст задачи..."
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={alsoRemove}
            onChange={(e) => setAlsoRemove(e.target.checked)}
          />
          Также убрать из очереди
        </label>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          <Button size="sm" onClick={submit} disabled={submitting || !text.trim()}>
            {submitting ? "..." : "Создать"}
          </Button>
        </div>
      </div>
    </div>
  );
}
