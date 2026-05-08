import { RefObject, useEffect, useRef } from "react";

type Opts = {
  containerRef: RefObject<HTMLDivElement>;
  onLoadMore: () => Promise<{ added: number }>;
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
          const { added } = await opts.onLoadMore();
          if (added === 0) {
            reachedTopRef.current = true;
            io.disconnect();
          } else {
            requestAnimationFrame(() => {
              container.scrollTop =
                prevScrollTop + (container.scrollHeight - prevScrollHeight);
            });
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
