import { useEffect, useId, useRef } from "react";
import { SIZE_CLASS_QUERIES } from "../shell/size-class";
import { readTouch } from "../shell/touch";

// Back closes an open overlay first (mobile app plan Decision 25, layout spec §15): on a compact
// touch window an open drawer or bottom sheet holds one history entry carrying a marker in
// `history.state`. The system back (Android's back, the iOS edge swipe) pops it and the popstate
// closes the overlay; any other close (scrim, drag, pick, Escape) pops the entry itself.

/** The key in `history.state` that marks an overlay's entry; its value is the overlay's id. */
export const OVERLAY_HISTORY_MARKER = "cbOverlay";

/** Entries pushed by open overlays, bottom first. */
const entries: string[] = [];
/** Entries released by a close and not yet popped: one traversal pops them together. */
let releasing: string[] = [];

/** Only a compact touch window keeps overlay entries (never a fine pointer, medium or expanded). */
function active(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return readTouch() && window.matchMedia(SIZE_CLASS_QUERIES.compact).matches;
}

function markerOf(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const v = (state as Record<string, unknown>)[OVERLAY_HISTORY_MARKER];
  return typeof v === "string" ? v : undefined;
}

/** Pops, in one traversal, the entries of the overlays closed in this tick. */
function flushReleased() {
  const ids = releasing;
  releasing = [];
  // The page moved on meanwhile (a pick that navigated): the entry is no longer the current one,
  // so there is nothing of ours to pop.
  const top = markerOf(window.history.state);
  if (top === undefined || !ids.includes(top)) return;
  const count = ids.length;
  if (count === 1) window.history.back();
  else window.history.go(-count);
}

/**
 * Ties an overlay's `open` state to the history while the window is a compact touch one: opening
 * pushes one entry, a back that leaves it calls `close`, a close of any other kind pops it once.
 * Two overlays open at once hold two entries and back closes the top one. Unmounting while open
 * pops the entry.
 */
export function useOverlayHistory(open: boolean, close: () => void): void {
  const id = useId();
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || !active()) return;
    window.history.pushState(
      { ...(window.history.state as object | null), [OVERLAY_HISTORY_MARKER]: id },
      "",
    );
    entries.push(id);
    let held = true;
    const onPop = () => {
      if (!held || markerOf(window.history.state) === id) return;
      // The back traversal already left the entry.
      held = false;
      const at = entries.indexOf(id);
      if (at >= 0) entries.splice(at, 1);
      latest.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!held) return;
      const at = entries.indexOf(id);
      if (at >= 0) entries.splice(at, 1);
      releasing.push(id);
      // Batched, so a sheet and the drawer closed together pop two entries in one step.
      if (releasing.length === 1) queueMicrotask(flushReleased);
    };
  }, [open, id]);
}
