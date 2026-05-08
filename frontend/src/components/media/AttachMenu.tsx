import React from "react";
import { Button } from "@/components/ui/button";
import { Image, Video, FileText } from "lucide-react";

type Props = {
  onPickPhoto: () => void;
  onPickVideo: () => void;
  onPickFile: () => void;
};

export function AttachMenu({ onPickPhoto, onPickVideo, onPickFile }: Props) {
  return (
    <div className="absolute bottom-full mb-2 left-4 z-30 bg-popover border border-border rounded-lg shadow-lg p-2 flex gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onPickPhoto}>
        <Image className="h-4 w-4 mr-1" /> Фото
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onPickVideo}>
        <Video className="h-4 w-4 mr-1" /> Видео
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onPickFile}>
        <FileText className="h-4 w-4 mr-1" /> Файл
      </Button>
    </div>
  );
}
