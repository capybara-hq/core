import { useSyncExternalStore } from "react";

/** The queries a touch device is made of (design spec §4.3); `TOUCH_QUERY` is their one spelling. */
export const POINTER_COARSE = "(pointer: coarse)";
export const ANY_POINTER_COARSE = "(any-pointer: coarse)";
export const ANY_POINTER_FINE = "(any-pointer: fine)";

/**
 * A touch device: the primary pointer is coarse, or a coarse pointer and no fine one. The same text
 * is the `@media` condition of the touch tokens in the generated tokens.css (`tokens.json` `touch`).
 */
export const TOUCH_QUERY = `${POINTER_COARSE}, ${ANY_POINTER_COARSE} and (not ${ANY_POINTER_FINE})`;

/** The compact size class (design spec §4: a window below 600 wide). */
export const COMPACT_QUERY = "(max-width: 599px)";

/**
 * Where controls take the mobile sizes (design spec §2.5, maintainer decision 2026-11-22): a compact
 * window, whatever the pointer, or a touch device at any width. The same text is the `@media`
 * condition of the size overrides in the generated tokens.css and of every control rule that goes
 * with them; the touch font stays under `TOUCH_QUERY` alone.
 */
export const MOBILE_SIZE_QUERY = `${COMPACT_QUERY}, ${TOUCH_QUERY}`;

const QUERIES = [POINTER_COARSE, ANY_POINTER_COARSE, ANY_POINTER_FINE] as const;

/** `TOUCH_QUERY` evaluated now; false without `matchMedia` (the server, old test environments). */
export function readTouch(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  const mq = (q: string) => window.matchMedia(q).matches;
  return mq(POINTER_COARSE) || (mq(ANY_POINTER_COARSE) && !mq(ANY_POINTER_FINE));
}

function subscribe(notify: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lists = QUERIES.map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener("change", notify);
  return () => {
    for (const l of lists) l.removeEventListener("change", notify);
  };
}

/**
 * Whether this is a touch device, following the pointer media features. `null` on the server and
 * during hydration (the first client render matches the server's), a boolean after.
 */
export function useTouch(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, readTouch, () => null);
}
