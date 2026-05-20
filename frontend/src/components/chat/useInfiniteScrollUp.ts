import { RefObject, useEffect, useRef } from "react";

type Opts = {
  containerRef: RefObject<HTMLDivElement>;
  onLoadMore: () => Promise<{ added: number; hasMore?: boolean }>;
  enabled: boolean;
  rootMargin?: string;
};

export function useInfiniteScrollUp(opts: Opts) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const reachedTopRef = useRef(false);

  useEffect(() => {
    reachedTopRef.current = false;
  }, [opts.containerRef]);

  useEffect(() => {
    if (!opts.enabled || reachedTopRef.current) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    const container = opts.containerRef.current;
    if (!sentinel || !container) return;

    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting || loadingRef.current) return;
        loadingRef.current = true;
        const prevScrollHeight = container.scrollHeight;
        const prevScrollTop = container.scrollTop;
        try {
          const { added, hasMore } = await opts.onLoadMore();
          if (added > 0) {
            requestAnimationFrame(() => {
              container.scrollTop =
                prevScrollTop + (container.scrollHeight - prevScrollHeight);
            });
          }
          // Stop only when the server tells us we're at the very top.
          // hasMore===false → reached top, otherwise keep listening (next
          // intersection will retry, including the added===0 case where the
          // page held only filtered-out items).
          if (hasMore === false) {
            reachedTopRef.current = true;
            io.disconnect();
          }
        } catch {
          /* swallow — next intersection retries */
        } finally {
          loadingRef.current = false;
        }
      },
      { root: container, rootMargin: opts.rootMargin ?? "200px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [opts.enabled, opts.onLoadMore, opts.containerRef, opts.rootMargin]);

  return { sentinelRef };
}
