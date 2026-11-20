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
