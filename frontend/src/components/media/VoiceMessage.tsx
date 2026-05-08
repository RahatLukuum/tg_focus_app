// frontend/src/components/media/VoiceMessage.tsx
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-react";
import { formatDuration } from "./format";

export function VoiceMessage({ url, duration }: { url: string; duration?: number }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.preload = "metadata";
    const updateProgress = () => {
      setCurrentTime(audio.currentTime);
      setProgress((audio.currentTime / (audio.duration || 1)) * 100);
    };
    const handleEnded = () => { setIsPlaying(false); setProgress(0); setCurrentTime(0); };
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("ended", handleEnded);
    return () => {
      audio.removeEventListener("timeupdate", updateProgress);
      audio.removeEventListener("ended", handleEnded);
      audio.pause();
    };
  }, [url]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) audioRef.current.pause();
    else audioRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const percentage = x / bounds.width;
    audioRef.current.currentTime = percentage * (audioRef.current.duration || 0);
    setProgress(percentage * 100);
  };

  return (
    <div className="flex items-center gap-3 mb-1 min-w-[200px]">
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="h-10 w-10 rounded-full shrink-0"
        onClick={togglePlay}
      >
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-1" />}
      </Button>
      <div className="flex-1 flex flex-col gap-1">
        <div
          className="h-1.5 w-full bg-primary/20 rounded-full cursor-pointer relative"
          onClick={handleSeek}
        >
          <div
            className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-75"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] opacity-70">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
    </div>
  );
}
