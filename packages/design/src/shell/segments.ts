import { useSyncExternalStore } from "react";

/** One viewport segment: a screen of a folded or dual-screen display, in CSS px. */
export type ViewportSegment = { x: number; y: number; width: number; height: number };

const SEGMENT_QUERIES = [
  "(horizontal-viewport-segments: 2)",
  "(vertical-viewport-segments: 2)",
] as const;

type WithViewport = Window & { viewport?: { segments?: readonly ViewportSegment[] | null } };

let cached: { key: string; value: ViewportSegment[] } | null = null;

/** The two segments of `window.viewport`, a stable array while they do not change, else null. */
function read(): ViewportSegment[] | null {
  if (typeof window === "undefined") return null;
  const segments = (window as WithViewport).viewport?.segments;
  if (!segments || segments.length !== 2) return null;
  const value = segments.map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));
  const key = JSON.stringify(value);
  if (cached?.key !== key) cached = { key, value };
  return cached.value;
}

function subscribe(notify: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const lists =
    typeof window.matchMedia === "function" ? SEGMENT_QUERIES.map((q) => window.matchMedia(q)) : [];
  for (const l of lists) l.addEventListener("change", notify);
  window.addEventListener("resize", notify);
  return () => {
    for (const l of lists) l.removeEventListener("change", notify);
    window.removeEventListener("resize", notify);
  };
}

/**
 * The viewport segments when the window spans two screens (`window.viewport.segments`), else `null`:
 * no API, one segment, the server and hydration. Layout never depends on it (the segment media
 * queries in the stylesheet are the authority for first paint); it mirrors them for script, and
 * device posture is never read.
 */
export function useViewportSegments(): ViewportSegment[] | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
