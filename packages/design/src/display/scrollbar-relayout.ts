import { type RefObject, useEffect } from "react";

/**
 * Keeps the ancestors of a sideways-scrolling block sized to its scrollbar in WebKit.
 *
 * WebKit (Safari 27) sizes a flex or grid item before an `overflow: auto` descendant gets its
 * classic (always-visible) scrollbar and does not lay the item out again once it has one: the
 * block grows by the scrollbar, its flex ancestors keep the old height, and the scrollbar hangs
 * below the block over whatever follows (in the command approval card, over the buttons). Any
 * later layout of the ancestors corrects it; Chromium and Firefox need none. So whenever the
 * block's scrollbar comes, goes or changes thickness, its layout is dirtied once (a `min-height`
 * set and cleared around a forced layout): the next layout runs with the scrollbar known. Overlay
 * scrollbars take no space and never trigger it.
 */
export function useScrollbarRelayout(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // the thickness last laid out with; 0 at first, so a block mounted with a scrollbar is fixed
    let bar = 0;
    const ro = new ResizeObserver(() => {
      const next = el.offsetHeight - el.clientHeight;
      if (next === bar) return;
      bar = next;
      el.style.setProperty("min-height", "1px");
      void el.offsetHeight;
      el.style.removeProperty("min-height");
    });
    // the border box: a scrollbar changes it, not the content box
    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, [ref]);
}
