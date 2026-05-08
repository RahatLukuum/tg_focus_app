import React from "react";

type Props = {
  url: string;
  size?: number;
  onLightbox?: () => void;
};

export function VideoNoteView({ url, size = 240, onLightbox }: Props) {
  return (
    <div className="cursor-pointer" onClick={onLightbox}>
      <video
        src={`${url}#t=0.001`}
        className="rounded-full object-cover bg-black/10"
        style={{ width: size, height: size }}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
      />
    </div>
  );
}
