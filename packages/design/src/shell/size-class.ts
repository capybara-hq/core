import { useCallback, useSyncExternalStore } from "react";

/**
 * The window's size class (spec §4, mobile layout spec §3): by window width in CSS px only, never
 * by orientation, device model or user agent.
 */
export type SizeClass = "compact" | "medium" | "expanded";

/**
 * The class queries, the one place JS reads them from. The stylesheets spell the same widths
 * (`design-breakpoint` allows nothing else).
 */
export const SIZE_CLASS_QUERIES: Record<SizeClass, string> = {
  compact: "(max-width: 599px)",
  medium: "(min-width: 600px) and (max-width: 840px)",
  expanded: "(min-width: 841px)",
};

/** The conversation's right area is inline from this width (spec §5.4), a side sheet below. */
export const INLINE_RIGHT_AREA_QUERY = "(min-width: 1280px)";
export const INLINE_RIGHT_AREA_BELOW = "(max-width: 1279px)";

/** A window shorter than 480 CSS px (a phone in landscape): the shell sets `data-short`. */
export const SHORT_WINDOW_QUERY = "(max-height: 479px)";

/** The class of a window `width` CSS px wide. */
export function sizeClassOf(width: number): SizeClass {
  return width < 600 ? "compact" : width <= 840 ? "medium" : "expanded";
}

const CLASSES = Object.keys(SIZE_CLASS_QUERIES) as SizeClass[];

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function currentClass(): SizeClass | null {
  if (!hasMatchMedia()) return null;
  return CLASSES.find((c) => window.matchMedia(SIZE_CLASS_QUERIES[c]).matches) ?? null;
}

function subscribe(notify: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const lists = CLASSES.map((c) => window.matchMedia(SIZE_CLASS_QUERIES[c]));
  for (const l of lists) l.addEventListener("change", notify);
  return () => {
    for (const l of lists) l.removeEventListener("change", notify);
  };
}

/**
 * The window's size class: `null` in a server render and during hydration (the server does not
 * know the window; where a tree differs by class it draws every variant and CSS shows one), the
 * matching class afterwards, live as the window changes.
 */
export function useSizeClass(): SizeClass | null {
  return useSyncExternalStore(subscribe, currentClass, () => null);
}

/** The short-window flag (height below 480); false on the server and during hydration. */
export function useShortWindow(): boolean {
  const sub = useCallback((notify: () => void) => {
    if (!hasMatchMedia()) return () => {};
    const mql = window.matchMedia(SHORT_WINDOW_QUERY);
    mql.addEventListener("change", notify);
    return () => mql.removeEventListener("change", notify);
  }, []);
  return useSyncExternalStore(
    sub,
    () => hasMatchMedia() && window.matchMedia(SHORT_WINDOW_QUERY).matches,
    () => false,
  );
}
