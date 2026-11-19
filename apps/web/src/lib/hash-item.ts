import { useCallback, useEffect, useRef, useState } from "react";

const parse = (hash: string, key: string): string | null => {
  const m = new RegExp(`(?:^#|&)${key}=([^&]*)`).exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
};

/**
 * The open item of a list-detail region (design spec §6.47), kept in the URL hash (`#item=<id>`):
 * opening pushes a history entry while nothing is open (so the system back closes the item, and the
 * stack's back is that same step), choosing another item while one is open replaces the entry, and
 * `/inbox#item=<id>` deep-links. Read after mount and on `hashchange` / `popstate`: the server
 * render has no hash, so it draws the list.
 */
export function useHashItem(key = "item"): {
  id: string | null;
  open(id: string): void;
  close(): void;
} {
  const [id, setId] = useState<string | null>(null);
  const pushed = useRef(false);
  useEffect(() => {
    const read = () => setId(parse(window.location.hash, key));
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, [key]);
  const open = useCallback(
    (next: string) => {
      const hash = `#${key}=${encodeURIComponent(next)}`;
      const url = new URL(window.location.href);
      if (parse(url.hash, key) === null) {
        pushed.current = true;
        window.history.pushState(window.history.state, "", url.pathname + url.search + hash);
      } else {
        window.history.replaceState(window.history.state, "", url.pathname + url.search + hash);
      }
      setId(next);
    },
    [key],
  );
  const close = useCallback(() => {
    setId(null);
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }, []);
  return { id, open, close };
}
