// frontend/src/components/media/format.ts
export function formatDuration(s: number | undefined | null): string {
  if (s == null || !Number.isFinite(s)) return "--:--";
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function formatSize(bytes: number | undefined | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function extensionFor(fileName?: string, mimeType?: string): string {
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot > 0 && dot < fileName.length - 1) return fileName.slice(dot + 1).toUpperCase();
  }
  if (mimeType) {
    const slash = mimeType.lastIndexOf("/");
    if (slash > 0) return mimeType.slice(slash + 1).toUpperCase();
  }
  return "FILE";
}
