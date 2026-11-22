import { useLayoutEffect, useState } from "react";
import { COMPACT_QUERY } from "./touch";
import { useMediaQuery } from "./use-media-query";

/** What the one scroller of a compact pushed page reports (design spec §6.65). */
export type CompactScroll = {
  /** The large title has passed under the floating row: the row draws it. */
  titleAway: boolean;
  /** The quick-return bar (search and scopes) is scrolled away until the next upward scroll. */
  barHidden: boolean;
};

const NONE: CompactScroll = { titleAway: false, barHidden: false };

/** What counts as a person scrolling (a programmatic restore comes with none of these). */
const GESTURES = ["wheel", "touchstart", "pointerdown"] as const;
/** The keys that scroll a page; typing in a field is no scroll gesture. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isScrollKey(e: KeyboardEvent): boolean {
  if (!SCROLL_KEYS.has(e.key)) return false;
  const t = e.target;
  return !(t instanceof Element && t.closest(EDITABLE) !== null);
}

/**
 * The scrolled title and the quick-return bar of a pushed page that scrolls as one scroller on
 * compact (responsive system spec §2.6, D7; design spec §6.65).
 *
 * The hook takes the elements, not refs: a template keeps them in state through callback refs
 * (`const [scroller, setScroller] = useState<HTMLElement | null>(null)`, `ref={setScroller}`), so
 * a scroller that mounts late (loading, then content) or is replaced (a `ClassForms` prune) is
 * watched again and the old one is let go.
 *
 * - `titleAway` holds while the title's bottom is under the floating row: at or above the
 *   scroller's top plus `--cb-float-row` (read from the scroller when it attaches and again on
 *   every window or visual viewport resize; 0 where it is not set). The scroller must start
 *   under the floating row (its top at the row's top), as the shell's pushed page does.
 * - `barHidden` turns on when a person scrolls down past the title's bottom (the bar comes after
 *   the title; its own offset is useless once it is stuck), off on any upward scroll, and never
 *   while the content fits (an elastic overscroll still fires scroll events). Until the first
 *   gesture (wheel, touch or pointer on the scroller, or a scrolling key outside an editable
 *   field) a scroll has no direction, so a programmatic restore keeps the bar shown. The gesture
 *   is latched per attach: once a person has scrolled this scroller, every later scroll has a
 *   direction until the scroller changes. An overscroll bounce counts as no movement. Without
 *   `bar` it stays false.
 *
 * The scroll is read in one passive listener, at most once per animation frame. The first read
 * happens before paint when the listener attaches, so a page whose scroller was restored before it
 * mounted (back from a detail to a scrolled list) starts with the matching `titleAway` and the bar
 * shown. Outside compact, or without a scroller, the hook attaches nothing and reports both false.
 */
export function useCompactScroll(
  scroller: HTMLElement | null,
  title: HTMLElement | null,
  bar?: HTMLElement | null,
): CompactScroll {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [state, setState] = useState<CompactScroll>(NONE);

  useLayoutEffect(() => {
    const el = scroller;
    if (!compact || !el) return;
    let floatRow = floatRowOf(el);
    // The last position read, clamped to the scroll range so a rubber band past either end is
    // no movement.
    let last = clampTop(el);
    let frame = 0;
    let gesture = false;
    const read = (from: number | null) => {
      const top = clampTop(el);
      const box = el.getBoundingClientRect();
      const head = title?.getBoundingClientRect();
      const titleAway = head !== undefined && head.bottom <= box.top + floatRow;
      // the title's bottom in the scroller's content (never sticky, so always where it lies)
      const threshold = head === undefined ? 0 : head.bottom - box.top + top;
      setState((prev) => {
        let barHidden = prev.barHidden;
        if (!bar || from === null || el.scrollHeight <= el.clientHeight) barHidden = false;
        else if (top < from) barHidden = false;
        else if (top > from && gesture && top > threshold) barHidden = true;
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
    const onGesture = () => {
      gesture = true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isScrollKey(e)) gesture = true;
    };
    // The floating row follows the window (a rotation, a safe-area inset): read it again.
    const onResize = () => {
      floatRow = floatRowOf(el);
      onScroll();
    };
    const viewport = window.visualViewport;
    // The first read: a restored position, never a direction (the bar starts shown).
    read(null);
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const g of GESTURES) el.addEventListener(g, onGesture, { passive: true });
    window.addEventListener("keydown", onKey, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    viewport?.addEventListener("resize", onResize, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const g of GESTURES) el.removeEventListener(g, onGesture);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      viewport?.removeEventListener("resize", onResize);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [compact, scroller, title, bar]);

  return compact && scroller ? state : NONE;
}

function clampTop(el: HTMLElement): number {
  return Math.min(Math.max(el.scrollTop, 0), Math.max(el.scrollHeight - el.clientHeight, 0));
}

/**
 * `--cb-float-row` in px as the scroller sees it. A custom property computes to its tokens, so a
 * `calc()` (the shell's) is resolved by a hidden probe that is that high; absent: 0.
 */
function floatRowOf(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue("--cb-float-row").trim();
  if (raw === "") return 0;
  const px = /^-?[\d.]+px$/.test(raw) ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isNaN(px)) return px;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:var(--cb-float-row)";
  el.append(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}
