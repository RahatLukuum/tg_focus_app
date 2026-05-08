import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-react";
import { formatDuration, formatSize } from "./format";

type Props = {
  url: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
};

export function AudioPlayer({ url, fileName, fileSize, duration }: Props) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.preload = "metadata";
    const tick = () => {
      setCurrentTime(audio.currentTime);
      setProgress((audio.currentTime / (audio.duration || 1)) * 100);
    };
    const ended = () => { setIsPlaying(false); setProgress(0); setCurrentTime(0); };
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("ended", ended);
    return () => {
      audio.removeEventListener("timeupdate", tick);
      audio.removeEventListener("ended", ended);
      audio.pause();
    };
  }, [url]);

  const toggle = () => {
    if (!audioRef.current) return;
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = (e.clientX - r.left) / r.width;
    audioRef.current.currentTime = p * (audioRef.current.duration || 0);
    setProgress(p * 100);
  };

  return (
    <div className="flex items-center gap-3 p-2 rounded-md bg-background/40 border border-border min-w-[240px] max-w-full">
      <Button type="button" variant="secondary" size="icon" className="h-10 w-10 rounded-full shrink-0" onClick={toggle}>
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-1" />}
      </Button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{fileName ?? "Аудио"}</p>
        <div className="h-1.5 mt-1 w-full bg-primary/20 rounded-full cursor-pointer relative" onClick={seek}>
          <div className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-75" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between text-[10px] opacity-70 mt-0.5">
          <span>{formatDuration(currentTime)}</span>
          <span>
            {formatDuration(duration)} {fileSize ? `· ${formatSize(fileSize)}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
