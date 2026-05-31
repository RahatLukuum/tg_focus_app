import * as React from "react";
import { cn } from "@/lib/utils";

export interface AutoResizeTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> {
  /** Visible rows at the smallest state. Default 1. */
  minRows?: number;
  /** Hard cap on rows before the textarea starts scrolling. Default 6. */
  maxRows?: number;
}

/**
 * A textarea that grows with its content up to `maxRows`, then scrolls. Designed
 * to drop into the same slot as `<Input>` (matches the h-10 baseline).
 */
export const AutoResizeTextarea = React.forwardRef<
  HTMLTextAreaElement,
  AutoResizeTextareaProps
>(({ className, minRows = 1, maxRows = 6, onChange, value, ...props }, ref) => {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    },
    [ref],
  );

  const resize = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    // Reset so shrink-on-delete works, then measure scrollHeight.
    el.style.height = "auto";
    const computed = window.getComputedStyle(el);
    const lineHeight = parseFloat(computed.lineHeight || "20") || 20;
    const paddingY =
      (parseFloat(computed.paddingTop) || 0) +
      (parseFloat(computed.paddingBottom) || 0);
    const max = lineHeight * maxRows + paddingY;
    const min = lineHeight * minRows + paddingY;
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [minRows, maxRows]);

  React.useEffect(() => {
    resize();
  }, [resize, value]);

  return (
    <textarea
      ref={setRefs}
      rows={minRows}
      value={value}
      onChange={(e) => {
        onChange?.(e);
        resize();
      }}
      className={cn(
        "flex min-h-10 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm leading-6",
        className,
      )}
      {...props}
    />
  );
});
AutoResizeTextarea.displayName = "AutoResizeTextarea";
