import { type MouseEvent, type PointerEvent, useCallback, useEffect, useRef } from "react";

/** How long a touch must rest before it counts as a long press (responsive system spec §2.4). */
export const LONG_PRESS_MS = 500;
/** How far a touch may move before it is a scroll and no long press. */
export const LONG_PRESS_SLOP = 10;

export type LongPressHandlers = {
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onContextMenu(e: MouseEvent<HTMLElement>): void;
  onClickCapture(e: MouseEvent<HTMLElement>): void;
};

const NONE: LongPressHandlers = {
  onPointerDown() {},
  onPointerMove() {},
  onPointerUp() {},
  onPointerCancel() {},
  onContextMenu() {},
  onClickCapture() {},
};

/**
 * Long press and the context menu on one element (responsive system spec §2.4, plan T0.3): a touch
 * that rests `LONG_PRESS_MS` without moving more than `LONG_PRESS_SLOP` px, or a `contextmenu`
 * event (right click, two-finger tap, Android's long press), calls `onLongPress`. The browser's
 * own context menu is prevented, and after a touch long press the click its release sends is
 * eaten (on the window, in the capture phase), so a row link does not navigate. Disabled (`enabled: false`), it hands back no-op
 * handlers and leaves the browser's context menu alone.
 */
export function useLongPress(
  onLongPress: () => void,
  opts: { enabled?: boolean } = {},
): LongPressHandlers {
  const enabled = opts.enabled ?? true;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const swallow = useRef<((e: Event) => void) | null>(null);
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);
  const unswallow = useCallback(() => {
    if (swallow.current !== null) window.removeEventListener("click", swallow.current, true);
    swallow.current = null;
  }, []);
  /**
   * The click a long press's release sends is eaten on the window in the capture phase, before
   * any handler of the page (a drawer's own capture handler would otherwise navigate first).
   */
  const fire = useCallback(() => {
    fired.current = true;
    unswallow();
    const eat = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      unswallow();
    };
    swallow.current = eat;
    window.addEventListener("click", eat, true);
    latest.current();
  }, [unswallow]);
  useEffect(
    () => () => {
      clear();
      unswallow();
    },
    [clear, unswallow],
  );
  if (!enabled) return NONE;
  return {
    onPointerDown(e) {
      fired.current = false;
      // a long press whose release sent no click: the next press clicks normally
      unswallow();
      // The timer is for touch: a mouse has its right button (the contextmenu event).
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      clear();
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fire();
      }, LONG_PRESS_MS);
    },
    onPointerMove(e) {
      const s = start.current;
      if (s === null) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu(e) {
      e.preventDefault();
      // A touch long press also sends contextmenu (Android): the timer has fired or is about to.
      const pending = timer.current !== null;
      clear();
      if (fired.current && !pending) return;
      // a touch's release may still click (eat it); a right click sends no click after it
      if (pending) fire();
      else {
        fired.current = true;
        latest.current();
      }
    },
    onClickCapture(e) {
      // the window listener has eaten the release's click; this guards a click it missed
      if (!fired.current || swallow.current === null) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
