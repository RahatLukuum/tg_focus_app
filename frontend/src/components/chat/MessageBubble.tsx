import React from "react";
import type { MediaType } from "@/types/telegram";
import { MediaRenderer } from "@/components/media/MediaRenderer";
import type { LightboxItem } from "@/components/media/Lightbox";
import { Linkify } from "./Linkify";

export type BubbleMessage = {
  id: number;
  text: string;
  isOutgoing: boolean;
  time: string;
  senderName?: string;
  mediaType?: MediaType;
  mediaUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  forwarded?: boolean;
  forwardFromName?: string;
};

type Props = {
  message: BubbleMessage;
  showSenderName?: boolean;
  onLightbox?: (item: LightboxItem) => void;
};

export function MessageBubble({ message, showSenderName, onLightbox }: Props) {
  const wrapperJustify = message.isOutgoing ? "justify-end" : "justify-start";
  const bubbleColor = message.isOutgoing
    ? "bg-primary text-primary-foreground"
    : "bg-muted";
  const timeColor = message.isOutgoing
    ? "text-primary-foreground/70"
    : "text-muted-foreground";

  return (
    <div className={`flex ${wrapperJustify}`}>
      <div
        className={[
          "px-4 py-2 rounded-2xl",
          "max-w-[85%] sm:max-w-[70%] md:max-w-[60%]",
          "break-words [overflow-wrap:anywhere]",
          bubbleColor,
        ].join(" ")}
      >
        {showSenderName && message.senderName && (
          <p className="text-xs font-semibold text-blue-500 mb-0.5">{message.senderName}</p>
        )}
        {message.forwarded && (
          <div className={[
            "mb-1 pl-2 border-l-2",
            message.isOutgoing
              ? "border-primary-foreground/40 text-primary-foreground/80"
              : "border-blue-500 text-blue-500",
          ].join(" ")}>
            <p className="text-[11px] leading-tight opacity-70">Переслано от</p>
            <p className="text-xs font-medium leading-tight">
              {message.forwardFromName || "скрытого пользователя"}
            </p>
          </div>
        )}
        {message.mediaType && message.mediaUrl && (
          <MediaRenderer
            mediaType={message.mediaType}
            mediaUrl={message.mediaUrl}
            fileName={message.fileName}
            fileSize={message.fileSize}
            mimeType={message.mimeType}
            duration={message.duration}
            onLightbox={onLightbox}
          />
        )}
        {message.text && (
          <p className="text-sm whitespace-pre-wrap">
            <Linkify>{message.text}</Linkify>
          </p>
        )}
        <p className={`text-[11px] mt-1 ${timeColor}`}>{message.time}</p>
      </div>
    </div>
  );
}
