import { useCallback, useRef } from "react";

/** Within this many px of the bottom counts as "at the bottom": new content is followed. */
const FOLLOW_SLACK = 48;

/** Whether the browser keeps the visible content still when content outside the viewport grows. */
function nativeAnchoring(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("overflow-anchor", "auto")
    : false;
}

/**
 * The topmost item of the scroller's content that is at least partly visible, descending into a
 * wrapper taller than the view (the thread's log, a list) for a steadier item; null when nothing
 * measures (no layout).
 */
function topVisible(el: HTMLElement): HTMLElement | null {
  const top = el.getBoundingClientRect().top;
  let parent: Element | null = el.firstElementChild;
  let found: HTMLElement | null = null;
  while (parent) {
    // the items stack top to bottom: the first whose bottom is below the view's top, by halving
    const items = parent.children;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((items[mid] as Element).getBoundingClientRect().bottom > top) hi = mid;
      else lo = mid + 1;
    }
    let next: HTMLElement | null = null;
    for (let i = lo; i < items.length && next === null; i++) {
      const c = items[i] as HTMLElement;
      if (c.getBoundingClientRect().height > 0) next = c;
    }
    if (next === null) break;
    found = next;
    if (next.children.length === 0 || next.getBoundingClientRect().height <= el.clientHeight) break;
    parent = next;
  }
  return found;
}

const isLog = (n: Node): n is HTMLElement =>
  n instanceof HTMLElement && n.getAttribute("role") === "log";

/**
 * The thread's rows: the children of the scroller's one content wrapper, where a `role="log"` child
 * (the web thread's one list of rows) stands for its own children. Each measured row gets
 * `content-visibility: auto` and its height as `contain-intrinsic-size` (`auto` keeps the browser's
 * own last-rendered size once it has one), so the first paint never skips a row and off-screen
 * rows skip layout and paint afterwards; rows are observed one by one, so a streaming row
 * re-measures only itself. A row added after the first render is reported to `onAdded`, which is
 * how the page learns of new content at the newest end (not of history prepended above, nor of a
 * row growing in place).
 */
function lightenItems(wrapper: Element | null, onAdded: (row: HTMLElement) => void): () => void {
  if (!wrapper || typeof ResizeObserver === "undefined") return () => {};
  const apply = (item: HTMLElement, height: number) => {
    if (!(height > 0)) return;
    item.style.setProperty("content-visibility", "auto");
    item.style.setProperty("contain-intrinsic-size", `none auto ${Math.round(height)}px`);
  };
  // `contain-intrinsic-size` is the content box: a border-box height would grow the row by its
  // padding and border at every measure.
  const contentHeight = (item: HTMLElement, entry: ResizeObserverEntry) => {
    const box = entry.contentBoxSize?.[0]?.blockSize;
    if (box !== undefined) return box;
    const cs = getComputedStyle(item);
    const frame = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce(
      (sum, k) => sum + (Number.parseFloat(cs[k as "paddingTop"]) || 0),
      0,
    );
    return item.getBoundingClientRect().height - frame;
  };
  const measure = new ResizeObserver((entries) => {
    for (const e of entries) {
      const item = e.target as HTMLElement;
      // a skipped row reports its intrinsic size, not its own: only rendered rows are measured
      if (
        typeof item.checkVisibility === "function" &&
        !item.checkVisibility({ contentVisibilityAuto: true })
      ) {
        continue;
      }
      apply(item, contentHeight(item, e));
    }
  });
  let items: MutationObserver;
  const container = (c: Element) => {
    items.observe(c, { childList: true });
    for (const child of Array.from(c.children)) {
      if (isLog(child)) container(child);
      else measure.observe(child);
    }
  };
  items = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.removedNodes)) {
        if (!(n instanceof HTMLElement)) continue;
        measure.unobserve(n);
        if (isLog(n)) for (const c of Array.from(n.children)) measure.unobserve(c);
      }
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof HTMLElement)) continue;
        if (isLog(n)) container(n);
        else {
          measure.observe(n);
          onAdded(n);
        }
      }
    }
  });
  container(wrapper);
  return () => {
    items.disconnect();
    measure.disconnect();
  };
}

/**
 * A thread that follows the newest message. The thread's scroll container is anchored at the
 * bottom by CSS (`flex-direction: column-reverse` around one content wrapper, so its scroll origin,
 * `scrollTop` 0, is the bottom): the first painted frame, server HTML before any script, already
 * shows the latest message, and content growing while the reader is at the bottom stays in view
 * without script. This hook adds what CSS cannot: within `FOLLOW_SLACK` of the bottom still counts
 * as following (the view snaps back to the bottom when content grows), and once the reader scrolls
 * further up the visible content stays still while new content arrives (browsers with scroll
 * anchoring do that themselves; elsewhere the hook keeps the topmost visible item where it was,
 * which holds for content arriving below and for earlier history prepended above alike, and falls
 * back to the distance from the top when nothing measures). Scrolling is
 * always instant (never smooth): a smooth scroll chases growing streamed content, and instant
 * scrolling also honors prefers-reduced-motion.
 *
 * `onUnseen(true)` fires when content arrives while the reader is away from the bottom (the
 * "latest" button), `onUnseen(false)` once they are back within the slack or the scroller is
 * released. Only a row added at the newest end counts: a resize (the keyboard, a closing sheet),
 * history prepended above and layout growth without a new row raise nothing.
 *
 * It also lightens long threads: each item of the thread (the children of the scroller's one
 * content wrapper) gets `content-visibility: auto` with a `contain-intrinsic-size` from its last
 * measured height once it has been measured, so off-screen items skip layout and paint while the
 * DOM, find in page and scroll anchoring stay whole.
 *
 * Returns a callback ref, so it attaches again whenever the scroll element is replaced. In a
 * container that is not reversed it scrolls to the bottom on attach and while following.
 */
export function useFollowBottom<T extends HTMLElement>(
  onUnseen?: (unseen: boolean) => void,
): (el: T | null) => (() => void) | undefined {
  const report = useRef(onUnseen);
  report.current = onUnseen;
  return useCallback((el: T | null) => {
    if (!el) return undefined;
    const reversed = getComputedStyle(el).flexDirection === "column-reverse";
    const anchoring = nativeAnchoring();
    // Distance from the bottom of the scroll range, whichever way the container scrolls.
    const gap = () => (reversed ? -el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop);
    const range = () => el.scrollHeight - el.clientHeight;
    let following = true;
    let unseen = false;
    const setUnseen = (v: boolean) => {
      if (unseen === v) return;
      unseen = v;
      report.current?.(v);
    };
    let fromTop = range() - gap();
    /** The topmost visible item and its offset from the scroller's top (no scroll anchoring). */
    let anchor: HTMLElement | null = null;
    let anchorAt = 0;
    const offsetOf = (a: HTMLElement) =>
      a.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const remember = () => {
      following = gap() <= FOLLOW_SLACK;
      if (following) setUnseen(false);
      fromTop = range() - gap();
      if (reversed && !anchoring && !following) {
        anchor = topVisible(el);
        anchorAt = anchor === null ? 0 : offsetOf(anchor);
      } else anchor = null;
    };
    const onGrow = () => {
      if (following) {
        el.scrollTop = reversed ? 0 : el.scrollHeight;
      } else if (reversed && !anchoring) {
        // No scroll anchoring: a reversed container keeps the distance from the bottom, so growth
        // below would push what the reader looks at up while history prepended above leaves it
        // still. Keep the topmost visible item where it was; without layout, the distance from
        // the top.
        if (anchor?.isConnected) {
          const moved = offsetOf(anchor) - anchorAt;
          if (moved !== 0) el.scrollTop += moved;
        } else el.scrollTop = fromTop - range();
      }
      remember();
    };
    // A reversed container already opens at the bottom (server HTML included); it is never
    // scrolled here, so a reader who scrolled up before the script ran stays where they are.
    if (!reversed) el.scrollTop = el.scrollHeight;
    remember();
    el.addEventListener("scroll", remember, { passive: true });
    const mutations = new MutationObserver(onGrow);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    // The viewport getting shorter (window resize, a taller composer) and the content growing
    // without a DOM change (an image or an extension block laying out) keep the bottom too.
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(onGrow);
    resize?.observe(el);
    if (el.firstElementChild) resize?.observe(el.firstElementChild);
    const lighten = lightenItems(el.firstElementChild, (row) => {
      // New content at the newest end while away from the bottom: it extends past the view's bottom
      // edge (history prepended above, or a row growing in place, never does).
      if (following) return;
      if (row.getBoundingClientRect().bottom > el.getBoundingClientRect().bottom) setUnseen(true);
    });
    return () => {
      setUnseen(false);
      el.removeEventListener("scroll", remember);
      mutations.disconnect();
      resize?.disconnect();
      lighten();
    };
  }, []);
}
