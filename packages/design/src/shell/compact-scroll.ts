import { type RefObject, useEffect, useState } from "react";
import { COMPACT_QUERY } from "./touch";
import { useMediaQuery } from "./use-media-query";

/** What the one scroller of a compact pushed page reports (design spec §6.65). */
export type CompactScroll = {
  /** The large title has passed above the scroller's top: the floating row draws it. */
  titleAway: boolean;
  /** The quick-return bar (search and scopes) is scrolled away until the next upward scroll. */
  barHidden: boolean;
};

const NONE: CompactScroll = { titleAway: false, barHidden: false };

/**
 * The scrolled title and the quick-return bar of a pushed page that scrolls as one scroller on
 * compact (responsive system spec §2.6, D7; design spec §6.65). `titleAway` holds while the
 * title's bottom is above the scroller's top. `barHidden` turns on when a scroll down passes the
 * bar's offset and off on any upward scroll, and never while the content fits (an elastic
 * overscroll still fires scroll events). An overscroll bounce counts as no movement.
 *
 * The scroll is read in one passive listener, at most once per animation frame. The state is
 * measured once when the listener attaches, so a page whose scroller was restored before it
 * mounted (back from a detail to a scrolled list) starts with the matching `titleAway`, and the
 * bar shown. Outside compact the hook attaches nothing and reports both false.
 */
export function useCompactScroll(
  scroller: RefObject<HTMLElement | null>,
  title: RefObject<HTMLElement | null>,
  bar?: RefObject<HTMLElement | null>,
): CompactScroll {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [state, setState] = useState<CompactScroll>(NONE);

  useEffect(() => {
    const el = scroller.current;
    if (!compact || !el) {
      setState(NONE);
      return;
    }
    // The last position read, clamped to the scroll range so a rubber band past either end is
    // no movement.
    let last = clampTop(el);
    let frame = 0;
    const read = (from: number | null) => {
      const top = clampTop(el);
      const head = title.current;
      const titleAway =
        head !== null && head.getBoundingClientRect().bottom <= el.getBoundingClientRect().top;
      setState((prev) => {
        let barHidden = prev.barHidden;
        const offset = bar?.current?.offsetTop;
        if (offset === undefined || el.scrollHeight <= el.clientHeight) barHidden = false;
        else if (from !== null && top < from) barHidden = false;
        else if (from !== null && top > from && top > offset) barHidden = true;
        return prev.titleAway === titleAway && prev.barHidden === barHidden
          ? prev
          : { titleAway, barHidden };
      });
      last = top;
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        read(last);
      });
    };
    // The first read: a restored position, never a direction (the bar starts shown).
    setState(NONE);
    read(null);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [compact, scroller, title, bar]);

  return compact ? state : NONE;
}

function clampTop(el: HTMLElement): number {
  return Math.min(Math.max(el.scrollTop, 0), Math.max(el.scrollHeight - el.clientHeight, 0));
}
