import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Scroll restoration of a ListPage's one scroller (responsive system spec §2.6; design spec §6.65).

/** The session key of a list's scroll position at a location (path and query). */
const PREFIX = "cb-list-scroll:";
/** The stored locations, oldest first: at most {@link MAX_KEYS} are kept. */
const INDEX = "cb-list-scroll-index";
const MAX_KEYS = 50;
/** Layout changes a restore waits for content tall enough before it settles for less. */
const MAX_TRIES = 20;
/** What a person does to scroll: from then on the position is theirs, nothing is owed. */
const GESTURES = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export const here = () => `${window.location.pathname}${window.location.search}`;

type Traversal = { url: string; entry: string | null; length: number };

/** The Navigation API's current entry key, where the browser has one (none in jsdom). */
function entryKey(): string | null {
  const nav = (window as { navigation?: { currentEntry?: { key?: string } | null } }).navigation;
  return nav?.currentEntry?.key ?? null;
}
const snapshot = (): Traversal => ({
  url: here(),
  entry: entryKey(),
  length: window.history.length,
});

/** The last back or forward traversal no list has taken yet. */
let traversal: Traversal | null = null;
let listening = false;

/**
 * Records back / forward traversals. Installed when this module is evaluated in a browser, so
 * before an app router mounts and adds its own popstate listener; ListPage calls it again on
 * mount for a module evaluated elsewhere. A click (a fresh navigation) drops what no list took.
 */
export function listenForTraversals(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("popstate", () => {
    traversal = snapshot();
  });
  window.addEventListener(
    "click",
    () => {
      traversal = null;
    },
    { capture: true, passive: true },
  );
}
listenForTraversals();

/**
 * Whether the location now is where a back or forward traversal landed, taking it (once). True
 * while a popstate event is being dispatched (a router that renders the traversal eagerly, inside
 * the event, possibly before this module's listener ran), or when the recorded traversal is for
 * this very history entry: the same location and the same Navigation API entry, or without that
 * API the same history length (a later push to the same location changes it). A recorded
 * traversal for anything else is stale and dropped, so it never restores a later fresh visit.
 */
export function takeTraversal(): boolean {
  if (window.event?.type === "popstate") {
    traversal = null;
    return true;
  }
  const t = traversal;
  if (t === null) return false;
  traversal = null;
  const now = snapshot();
  if (t.url !== now.url) return false;
  return t.entry !== null && now.entry !== null ? t.entry === now.entry : t.length === now.length;
}

export function readScroll(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    const v = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Stores a position and keeps the {@link MAX_KEYS} most recently written locations. */
export function writeScroll(key: string, top: number): void {
  try {
    const store = window.sessionStorage;
    store.setItem(PREFIX + key, String(Math.round(top)));
    const parsed: unknown = JSON.parse(store.getItem(INDEX) ?? "[]");
    const keys = Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
    if (keys[keys.length - 1] === key) return;
    const next = [...keys.filter((k) => k !== key), key];
    while (next.length > MAX_KEYS) {
      const old = next.shift();
      if (old !== undefined) store.removeItem(PREFIX + old);
    }
    store.setItem(INDEX, JSON.stringify(next));
  } catch {
    // storage blocked (a private window): the list simply starts at the top on back
  }
}

/**
 * Every scroll of the list's scroller stores the position for the current location (once per
 * animation frame). A traversal to a location (the list mounting, or the same list kept when only
 * the query changed) owes the stored position: on mount it is set in the scroller's ref, before
 * the frame's first read, so the scrolled title and the position come back together and nothing
 * paints at the top first; on an update in a layout effect. While the content is shorter than the
 * owed position (still loading, rows still arriving) the scroll is not stored, and the restore is
 * retried on every render and every size change of the body, up to {@link MAX_TRIES} times or
 * until a person scrolls, then settles for the furthest position there is. Returns the ref for
 * the template root.
 */
export function useScrollRestore(loaded: boolean): (el: HTMLDivElement | null) => void {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const owed = useRef<number | null>(null);
  const tries = useRef(0);
  const ready = useRef(loaded);
  ready.current = loaded;
  const take = useCallback(() => {
    if (!takeTraversal()) return;
    owed.current = readScroll(here());
    tries.current = 0;
  }, []);
  const settle = useCallback((el: HTMLElement) => {
    const want = owed.current;
    if (want === null || !ready.current) return;
    const max = Math.max(el.scrollHeight - el.clientHeight, 0);
    if (max < want && ++tries.current <= MAX_TRIES) return;
    el.scrollTop = Math.min(want, max);
    owed.current = null;
  }, []);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      setScroller(el);
      if (el === null) return;
      listenForTraversals();
      take();
      settle(el);
    },
    [take, settle],
  );
  // Every render: a list that loaded or grew takes what it is owed, and a traversal that changed
  // only the query (the same list kept mounted) owes the position stored for the new location.
  useLayoutEffect(() => {
    if (!scroller) return;
    take();
    settle(scroller);
  });
  useLayoutEffect(() => {
    if (!scroller) return;
    let frame = 0;
    let key = "";
    const save = () => writeScroll(key, scroller.scrollTop);
    const onScroll = () => {
      // a restore still owed: this is a clamped position, not one a person chose
      if (owed.current !== null) return;
      // the location now: a later write after the page has gone must not land on the next one
      key = here();
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        save();
      });
    };
    const onGesture = () => {
      if (owed.current === null) return;
      tries.current = MAX_TRIES;
      settle(scroller);
      owed.current = null;
    };
    const body = scroller.querySelector(".cb-body");
    const grown =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => settle(scroller));
    if (body) grown?.observe(body);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    for (const g of GESTURES) scroller.addEventListener(g, onGesture, { passive: true });
    return () => {
      grown?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      for (const g of GESTURES) scroller.removeEventListener(g, onGesture);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        save();
      }
    };
  }, [scroller, settle]);
  return ref;
}
