// frontend/src/components/media/Lightbox.tsx
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export type LightboxItem = { url: string; type: "photo" | "video" | "video_note" };

type Props = { item: LightboxItem | null; onClose: () => void };

export function Lightbox({ item, onClose }: Props) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 cursor-pointer"
      onClick={onClose}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 text-white hover:bg-white/20"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      >
        <X className="h-6 w-6" />
      </Button>
      <div className="max-w-full max-h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {item.type === "photo" && (
          <img src={item.url} alt="" className="max-w-full max-h-[90vh] object-contain" />
        )}
        {(item.type === "video" || item.type === "video_note") && (
          <video
            src={`${item.url}#t=0.001`}
            controls
            autoPlay
            playsInline
            className={
              item.type === "video_note"
                ? "max-w-full max-h-[90vh] rounded-full object-cover"
                : "max-w-full max-h-[90vh] object-contain"
            }
          />
        )}
      </div>
    </div>
  );
}
