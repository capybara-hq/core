import { type RefCallback, useEffect, useRef, useState } from "react";

/** How far before the list's end the next page is asked for (design spec §6.60). */
export const LIST_SENTINEL_MARGIN = "600px";

/**
 * The end of a list with more pages (mobile interaction model spec §3 "Infinite scroll", D6;
 * design spec §6.60): returns a ref for the list's last element, the sentinel. While there are
 * more pages and none is loading, the sentinel coming within {@link LIST_SENTINEL_MARGIN} of the
 * view (an `IntersectionObserver`) calls `onLoadMore` once; it arms again when a load has run
 * (`loading` went true and back) or `hasMore` comes back. Always the latest `onLoadMore`. Without
 * an `IntersectionObserver` nothing is asked for.
 */
export function useListSentinel(
  onLoadMore: () => void,
  opts: { hasMore: boolean; loading: boolean },
): RefCallback<Element> {
  const [el, setEl] = useState<Element | null>(null);
  const latest = useRef(onLoadMore);
  latest.current = onLoadMore;
  const armed = opts.hasMore && !opts.loading;
  useEffect(() => {
    if (!armed || el === null || typeof IntersectionObserver === "undefined") return;
    let asked = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (asked || !entries.some((e) => e.isIntersecting)) return;
        asked = true;
        latest.current();
      },
      { rootMargin: LIST_SENTINEL_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [armed, el]);
  return setEl;
}
