import React from "react";

const URL_RE = /(https?:\/\/[^\s]+)/g;

export function Linkify({ children }: { children: string }) {
  if (!children) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of children.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(children.slice(last, start));
    parts.push(
      <a
        key={`u-${i++}`}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all text-blue-500 hover:text-blue-400"
      >
        {match[0]}
      </a>
    );
    last = start + match[0].length;
  }
  if (last < children.length) parts.push(children.slice(last));
  return <>{parts}</>;
}
