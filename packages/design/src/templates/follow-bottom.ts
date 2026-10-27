import { useEffect, useRef } from "react";

/** Within this many px of the bottom counts as "at the bottom": new content is followed. */
const FOLLOW_SLACK = 48;

/**
 * A thread that follows the newest message: it scrolls to the bottom on mount and as content grows;
 * once the reader scrolls up it stops, and resumes near the bottom again. Scrolling is always
 * instant (never smooth): a smooth scroll chases growing streamed content, and instant scrolling
 * also honors prefers-reduced-motion.
 */
export function useFollowBottom<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let following = true;
    const toBottom = () => {
      if (following) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      following = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    };
    toBottom();
    el.addEventListener("scroll", onScroll, { passive: true });
    const mutations = new MutationObserver(toBottom);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    // 视口变矮（窗口缩放、输入区变高）时也保持贴底
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(toBottom);
    resize?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      mutations.disconnect();
      resize?.disconnect();
    };
  }, []);
  return ref;
}
