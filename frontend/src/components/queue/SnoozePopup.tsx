import { useState } from "react";
import { Button } from "@/components/ui/button";

const HOUR = 3600;
const DAY = 86400;

type Props = {
  open: boolean;
  onClose: () => void;
  onSnooze: (untilTs: number) => void;
};

function nextMorningAt9(): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function inOneWeek(): number {
  return Math.floor(Date.now() / 1000) + 7 * DAY;
}

const PRESETS = [
  { id: "1h", label: "1 час", offsetSeconds: HOUR },
  { id: "4h", label: "4 часа", offsetSeconds: 4 * HOUR },
] as const;

export function SnoozePopup({ open, onClose, onSnooze }: Props) {
  const [custom, setCustom] = useState<string>("");

  if (!open) return null;

  const choosePreset = (offsetSeconds: number) => {
    onSnooze(Math.floor(Date.now() / 1000) + offsetSeconds);
    onClose();
  };

  const submitCustom = () => {
    if (!custom) return;
    const ms = new Date(custom).getTime();
    if (!Number.isFinite(ms)) return;
    const ts = Math.floor(ms / 1000);
    if (ts <= Math.floor(Date.now() / 1000)) return;
    onSnooze(ts);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-lg max-w-sm w-full p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold">Отложить чат</h3>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="outline"
              size="sm"
              onClick={() => choosePreset(p.offsetSeconds)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onSnooze(nextMorningAt9());
              onClose();
            }}
          >
            Завтра 9:00
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onSnooze(inOneWeek());
              onClose();
            }}
          >
            Через неделю
          </Button>
        </div>
        <div className="flex flex-col gap-2 pt-2 border-t border-border">
          <label className="text-xs text-muted-foreground">Кастомное время:</label>
          <div className="flex gap-2">
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="flex-1 text-sm px-2 py-1 rounded border border-border bg-background"
            />
            <Button size="sm" onClick={submitCustom} disabled={!custom}>
              Отложить
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
