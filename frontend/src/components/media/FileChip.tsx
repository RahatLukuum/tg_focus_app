import React from "react";
import { Download } from "lucide-react";
import { extensionFor, formatSize } from "./format";

type Props = {
  url: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
};

export function FileChip({ url, fileName, fileSize, mimeType }: Props) {
  const ext = extensionFor(fileName, mimeType);
  return (
    <a
      href={url}
      download={fileName ?? "file"}
      className="flex items-center gap-3 p-3 bg-background/50 rounded-lg border border-border hover:bg-background/80 transition-colors mb-1 max-w-full"
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="h-10 w-10 shrink-0 rounded bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">
        {ext.slice(0, 4)}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium truncate">{fileName ?? "Файл"}</span>
        {fileSize ? (
          <span className="text-xs text-muted-foreground">{formatSize(fileSize)}</span>
        ) : null}
      </div>
      <Download className="ml-auto h-4 w-4 opacity-60 shrink-0" />
    </a>
  );
}
