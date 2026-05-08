import React from "react";
import { AudioPlayer } from "./AudioPlayer";
import { FileChip } from "./FileChip";
import type { LightboxItem } from "./Lightbox";
import { VideoNoteView } from "./VideoNoteView";
import { VoiceMessage } from "./VoiceMessage";
import type { MediaType } from "@/types/telegram";

type Props = {
  mediaType: MediaType;
  mediaUrl: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  onLightbox?: (item: LightboxItem) => void;
};

export function MediaRenderer({
  mediaType, mediaUrl, fileName, fileSize, mimeType, duration, onLightbox,
}: Props) {
  switch (mediaType) {
    case "photo":
      return (
        <img
          src={mediaUrl}
          alt=""
          loading="lazy"
          className="max-w-full max-h-64 rounded-md mb-1 cursor-pointer object-cover"
          onClick={() => onLightbox?.({ url: mediaUrl, type: "photo" })}
        />
      );
    case "video":
      return (
        <video
          src={`${mediaUrl}#t=0.001`}
          controls
          playsInline
          preload="metadata"
          className="max-w-full max-h-64 rounded-md mb-1 bg-black/10 cursor-pointer"
          onClick={(e) => { e.preventDefault(); onLightbox?.({ url: mediaUrl, type: "video" }); }}
        />
      );
    case "video_note":
      return (
        <VideoNoteView url={mediaUrl} onLightbox={() => onLightbox?.({ url: mediaUrl, type: "video_note" })} />
      );
    case "voice":
      return <VoiceMessage url={mediaUrl} duration={duration} />;
    case "audio":
      return <AudioPlayer url={mediaUrl} fileName={fileName} fileSize={fileSize} duration={duration} />;
    case "document":
    default:
      return <FileChip url={mediaUrl} fileName={fileName} fileSize={fileSize} mimeType={mimeType} />;
  }
}
