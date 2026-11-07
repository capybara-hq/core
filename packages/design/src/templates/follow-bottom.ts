import { useCallback } from "react";

/** Within this many px of the bottom counts as "at the bottom": new content is followed. */
const FOLLOW_SLACK = 48;

/** Whether the browser keeps the visible content still when content outside the viewport grows. */
function nativeAnchoring(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("overflow-anchor", "auto")
    : false;
}

/**
 * A thread that follows the newest message. The thread's scroll container is anchored at the
 * bottom by CSS (`flex-direction: column-reverse` around one content wrapper, so its scroll origin,
 * `scrollTop` 0, is the bottom): the first painted frame, server HTML before any script, already
 * shows the latest message, and content growing while the reader is at the bottom stays in view
 * without script. This hook adds what CSS cannot: within `FOLLOW_SLACK` of the bottom still counts
 * as following (the view snaps back to the bottom when content grows), and once the reader scrolls
 * further up the visible content stays still while new content arrives (browsers with scroll
 * anchoring do that themselves; elsewhere the hook keeps the distance from the top). Scrolling is
 * always instant (never smooth): a smooth scroll chases growing streamed content, and instant
 * scrolling also honors prefers-reduced-motion.
 *
 * Returns a callback ref, so it attaches again whenever the scroll element is replaced. In a
 * container that is not reversed it scrolls to the bottom on attach and while following.
 */
export function useFollowBottom<T extends HTMLElement>(): (
  el: T | null,
) => (() => void) | undefined {
  return useCallback((el: T | null) => {
    if (!el) return undefined;
    const reversed = getComputedStyle(el).flexDirection === "column-reverse";
    const anchoring = nativeAnchoring();
    // Distance from the bottom of the scroll range, whichever way the container scrolls.
    const gap = () => (reversed ? -el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop);
    const range = () => el.scrollHeight - el.clientHeight;
    let following = true;
    let fromTop = range() - gap();
    const remember = () => {
      following = gap() <= FOLLOW_SLACK;
      fromTop = range() - gap();
    };
    const onGrow = () => {
      if (following) {
        el.scrollTop = reversed ? 0 : el.scrollHeight;
      } else if (reversed && !anchoring) {
        // No scroll anchoring: a reversed container keeps the distance from the bottom, so
        // growth below would push what the reader looks at up; keep the distance from the top.
        el.scrollTop = fromTop - range();
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
    return () => {
      el.removeEventListener("scroll", remember);
      mutations.disconnect();
      resize?.disconnect();
    };
  }, []);
}
