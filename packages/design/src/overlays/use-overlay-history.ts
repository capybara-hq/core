import { useCallback, useEffect, useId, useRef } from "react";
import { SIZE_CLASS_QUERIES } from "../shell/size-class";
import { readTouch } from "../shell/touch";

// Back closes an open overlay first (mobile app plan Decision 25, layout spec §15): on a compact
// touch window an open drawer or bottom sheet holds one history entry. The system back (Android's
// back, the iOS edge swipe) pops it and the popstate closes the overlay; any other close (scrim,
// drag, Escape, a sheet's own button) pops the entry itself. The module keeps its own stack of the
// entries it pushed and decides from that: a router may rewrite `history.state` (Next's
// HistoryUpdater does on every router-state change), so nothing is read back from it.

/** The key stamped into the state of the entry an overlay pushes (informational only). */
export const OVERLAY_HISTORY_MARKER = "cbOverlay";

/** The overlays holding an entry, bottom first, with what closes each. */
const entries: { id: string; close: () => void }[] = [];
/** Entries released by a close and not yet popped: one traversal pops them together. */
let releasing: { href: string }[] = [];
/** Traversals this module started whose popstate has not arrived yet. */
let selfPops = 0;
/** What runs once the traversal of {@link popOverlaysThen} has landed. */
let afterPop: (() => void) | null = null;
/** The bound on that traversal (as the floating back's `goBack`): its popstate may never come. */
let afterPopTimer: ReturnType<typeof setTimeout> | null = null;
/** How long a pick waits for its pop's popstate before it runs anyway. */
export const POP_SETTLE_LIMIT_MS = 500;
let listening = false;
/**
 * Pushes waiting for this module's own traversal to land. A browser runs `history.back()` later, as
 * a traversal of its own: a push made meanwhile (a confirmation opened from an action sheet's pick
 * as the sheet's entry is popped) would be the entry that traversal pops.
 */
let waiting: (() => void)[] = [];
/** The bound on that wait (as {@link POP_SETTLE_LIMIT_MS}): its popstate may never come. */
let waitTimer: ReturnType<typeof setTimeout> | null = null;

const hrefNow = () => `${window.location.pathname}${window.location.search}`;

/** Only a compact touch window keeps overlay entries (never a fine pointer, medium or expanded). */
function active(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return readTouch() && window.matchMedia(SIZE_CLASS_QUERIES.compact).matches;
}

/** One popstate listener for the module, so a traversal of ours is counted even with no overlay. */
function onPopState() {
  if (selfPops > 0) {
    selfPops--;
    if (selfPops === 0 && afterPop !== null) runAfterPop();
    if (selfPops === 0) runWaiting();
    return;
  }
  // A back that is not ours leaves the top overlay's entry: that overlay closes.
  const top = entries.pop();
  top?.close();
}

/** Runs the pending pick once, whether its popstate came or the bound ran out. */
function runAfterPop() {
  if (afterPopTimer !== null) clearTimeout(afterPopTimer);
  afterPopTimer = null;
  const run = afterPop;
  afterPop = null;
  run?.();
}

/** Defers `push` until this module's traversals have landed (bounded). */
function whenSettled(push: () => void) {
  waiting.push(push);
  waitTimer ??= setTimeout(() => {
    waitTimer = null;
    // The pops never landed: they are no longer counted as ours, or they would swallow the next
    // real back (as the bound of popOverlaysThen does); a pick still waiting runs now.
    selfPops = 0;
    if (afterPop !== null) runAfterPop();
    runWaiting();
  }, POP_SETTLE_LIMIT_MS);
}

/** Runs the deferred pushes, in order, once nothing of ours is in flight (or the bound ran out). */
function runWaiting() {
  if (waitTimer !== null) clearTimeout(waitTimer);
  waitTimer = null;
  const list = waiting;
  waiting = [];
  for (const push of list) push();
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", onPopState);
}

/** Pops, in one traversal, the entries of the overlays closed in this tick. */
function flushReleased() {
  const items = releasing;
  releasing = [];
  // The page moved on meanwhile (a navigation committed): our entry is behind it, popping now
  // would travel the wrong way.
  const here = hrefNow();
  const count = items.filter((i) => i.href === here).length;
  if (count === 0) {
    if (selfPops === 0) runWaiting();
    return;
  }
  selfPops++;
  if (count === 1) window.history.back();
  else window.history.go(-count);
}

/**
 * Pops the entries of every open overlay in one traversal and runs `then` once it has landed
 * (mobile touch plan Task 28): a drawer pick navigates from the page's own entry, so one back
 * returns to the page before it and no stale overlay entry is left. The overlays stop holding
 * their entries at once (their closes pop nothing more). Returns false, running nothing, when no
 * overlay holds an entry (a fine pointer, a wider window): the caller navigates its usual way.
 */
export function popOverlaysThen(then: () => void): boolean {
  if (entries.length === 0) return false;
  const count = entries.length;
  entries.length = 0;
  // closes released earlier in this tick are covered by the same traversal
  const pending = releasing.filter((i) => i.href === hrefNow()).length;
  releasing = [];
  selfPops++;
  afterPop = then;
  // A traversal whose popstate never comes (a count past the real stack, a browser quirk) must not
  // lose the pick, nor leave a self-pop pending that would swallow the next real back.
  afterPopTimer = setTimeout(() => {
    afterPopTimer = null;
    if (afterPop !== then) return;
    selfPops = Math.max(0, selfPops - 1);
    runAfterPop();
    if (selfPops === 0) runWaiting();
  }, POP_SETTLE_LIMIT_MS);
  const n = count + pending;
  if (n === 1) window.history.back();
  else window.history.go(-n);
  return true;
}

/**
 * Ties an overlay's `open` state to the history while the window is a compact touch one: opening
 * pushes one entry, a back that leaves it calls `close`, a close of any other kind pops it once.
 * Two overlays open at once hold two entries and back closes the top one. Unmounting while open
 * pops the entry.
 *
 * Returns `leaveEntry`: call it just before a close that starts a navigation (a drawer pick). The
 * router's push is still pending then, so a traversal queued now would run after it and land on the
 * wrong entry; the entry is left behind instead (one extra back step to the same page).
 */
export function useOverlayHistory(open: boolean, close: () => void): { leaveEntry(): void } {
  const id = useId();
  const latest = useRef(close);
  latest.current = close;
  const leave = useRef(false);
  useEffect(() => {
    if (!open || !active()) return;
    leave.current = false;
    listen();
    const entry = { id, close: () => latest.current() };
    let href: string | null = null;
    const push = () => {
      window.history.pushState(
        { ...(window.history.state as object | null), [OVERLAY_HISTORY_MARKER]: id },
        "",
      );
      href = hrefNow();
      entries.push(entry);
    };
    // A pop of ours still in flight (an overlay closed just before this one opened) lands first.
    if (selfPops > 0 || releasing.length > 0) whenSettled(push);
    else push();
    return () => {
      if (href === null) {
        // closed before its entry was pushed: nothing to pop
        waiting = waiting.filter((p) => p !== push);
        return;
      }
      const at = entries.indexOf(entry);
      if (at < 0) return; // a back already took it
      entries.splice(at, 1);
      if (leave.current) return;
      releasing.push({ href });
      // Batched, so a sheet and the drawer closed together pop two entries in one step.
      if (releasing.length === 1) queueMicrotask(flushReleased);
    };
  }, [open, id]);
  const leaveEntry = useCallback(() => {
    leave.current = true;
  }, []);
  return { leaveEntry };
}
