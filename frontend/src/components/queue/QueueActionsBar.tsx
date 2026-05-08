import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Clock, ListTodo, SkipForward } from "lucide-react";
import { SnoozePopup } from "./SnoozePopup";
import { TaskFromChatForm } from "./TaskFromChatForm";

type Props = {
  chatId: number;
  chatTitle: string;
  onDone: () => void;
  onSnooze: (untilTs: number) => void;
  onSkip: () => void;
  /** Called after task was created. alsoRemove=true → also call onDone(). */
  onTaskCreated: (alsoRemove: boolean) => void;
};

export function QueueActionsBar({
  chatId,
  chatTitle,
  onDone,
  onSnooze,
  onSkip,
  onTaskCreated,
}: Props) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  return (
    <>
      <div className="grid grid-cols-4 gap-2 p-3 border-t border-border">
        <Button variant="default" onClick={onDone}>
          <Check className="h-4 w-4 mr-1" />
          Готово
        </Button>
        <Button variant="outline" onClick={() => setSnoozeOpen(true)}>
          <Clock className="h-4 w-4 mr-1" />
          Отложить
        </Button>
        <Button variant="outline" onClick={() => setTaskOpen(true)}>
          <ListTodo className="h-4 w-4 mr-1" />
          В задачи
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          <SkipForward className="h-4 w-4 mr-1" />
          Пропустить
        </Button>
      </div>

      <SnoozePopup
        open={snoozeOpen}
        onClose={() => setSnoozeOpen(false)}
        onSnooze={onSnooze}
      />
      <TaskFromChatForm
        open={taskOpen}
        chatId={chatId}
        chatTitle={chatTitle}
        onClose={() => setTaskOpen(false)}
        onCreated={onTaskCreated}
      />
    </>
  );
}
