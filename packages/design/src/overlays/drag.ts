import {
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// Follow-finger dismissal of a sheet (spec §6.7, mobile layout spec §7.4): the sheet tracks the
// pointer along its axis, a release past 40 % of its size or above a velocity threshold dismisses
// it, anything else springs back.

/** The share of the sheet's size a release must pass to dismiss it. */
export const DRAG_DISMISS_SHARE = 0.4;
/** A release faster than this (px per ms, toward the dismissed edge) dismisses at any distance. */
export const DRAG_DISMISS_VELOCITY = 0.5;
/** The distance the pointer travels before a press becomes a drag (a click stays a click). */
const DRAG_SLOP = 6;
/** The velocity is measured over the last stretch of the gesture, in ms. */
const VELOCITY_WINDOW = 100;
/** A settle that never gets its `transitionend` (nothing to move, a hidden tab) ends after this. */
const SETTLE_FALLBACK_MS = 400;

export type DragState = "idle" | "dragging" | "settling";

export type DragDismissOptions = {
  /** The axis the sheet moves along: a bottom sheet "y", a side sheet "x". */
  axis: "y" | "x";
  /** The sheet's size along the axis, read when a gesture starts and ends. */
  size: () => number;
  /** Called once the dismissing travel has finished. */
  onDismiss(): void;
  /**
   * A scrolling region inside the drag zone: a press that starts in it drags only while its
   * scroll is at the top (so content scrolling never fights the gesture).
   */
  scroller?: RefObject<HTMLElement | null>;
  /** +1 (default): dismissed toward the end edge (down, right); -1: toward the start edge. */
  direction?: 1 | -1;
};

export type DragDismiss = {
  /** Spread on the elements that start a drag (the handle and the head, or the whole sheet). */
  handleProps: HTMLAttributes<HTMLElement>;
  /** Spread on the moving sheet: its transform, `data-state` and the settle's end. */
  panelProps: HTMLAttributes<HTMLElement> & { "data-state": DragState };
  /** For a scrim behind the sheet: it fades with the dragged share (opacity `1 − share`). */
  scrimProps: HTMLAttributes<HTMLElement> & { "data-drag": DragState };
  state: DragState;
  /** The distance dragged toward the dismissed edge, in px (the settle's target while settling). */
  offset: number;
  /** `offset` as a share of the sheet's size, 0 to 1. */
  share: number;
};

type Gesture = {
  pointerId: number;
  start: number;
  startCross: number;
  active: boolean;
  fromBody: boolean;
  samples: { t: number; pos: number }[];
  size: number;
};

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function useDragDismiss(opts: DragDismissOptions): DragDismiss {
  const { axis, scroller, direction = 1 } = opts;
  const latest = useRef(opts);
  latest.current = opts;
  const [state, setState] = useState<DragState>("idle");
  const [offset, setOffset] = useState(0);
  const [size, setSize] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const dismissing = useRef(false);

  const finish = useCallback(() => {
    const was = dismissing.current;
    dismissing.current = false;
    setState("idle");
    setOffset(0);
    if (was) latest.current.onDismiss();
  }, []);

  // A settle ends on the sheet's `transitionend`; this timer covers a transition that never runs.
  useEffect(() => {
    if (state !== "settling") return;
    const id = window.setTimeout(finish, SETTLE_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [state, finish]);

  const pos = (e: ReactPointerEvent) => (axis === "y" ? e.clientY : e.clientX);
  const cross = (e: ReactPointerEvent) => (axis === "y" ? e.clientX : e.clientY);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (gesture.current !== null || state === "settling") return;
    const region = scroller?.current;
    const fromBody =
      region != null && e.target instanceof Node && region.contains(e.target as Node);
    if (fromBody && region.scrollTop > 0) return;
    gesture.current = {
      pointerId: e.pointerId,
      start: pos(e),
      startCross: cross(e),
      active: false,
      fromBody,
      samples: [{ t: performance.now(), pos: pos(e) }],
      size: latest.current.size(),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (g === null || e.pointerId !== g.pointerId) return;
    const along = (pos(e) - g.start) * direction;
    if (!g.active) {
      const across = Math.abs(cross(e) - g.startCross);
      if (Math.abs(along) < DRAG_SLOP && across < DRAG_SLOP) return;
      // Away from the dismissed edge, sideways, or into a body that scrolled meanwhile: not ours.
      const region = scroller?.current;
      if (along <= 0 || across > Math.abs(along) || (g.fromBody && (region?.scrollTop ?? 0) > 0)) {
        gesture.current = null;
        return;
      }
      g.active = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setSize(g.size);
      setState("dragging");
    }
    const now = performance.now();
    g.samples.push({ t: now, pos: pos(e) });
    while (g.samples.length > 2 && now - (g.samples[0]?.t ?? now) > VELOCITY_WINDOW) {
      g.samples.shift();
    }
    setOffset(Math.min(Math.max(along, 0), g.size));
  };

  const end = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (g === null || e.pointerId !== g.pointerId) return;
    gesture.current = null;
    if (!g.active) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const along = Math.min(Math.max((pos(e) - g.start) * direction, 0), g.size);
    const first = g.samples[0];
    const dt = performance.now() - (first?.t ?? 0);
    const velocity = first !== undefined && dt > 0 ? ((pos(e) - first.pos) * direction) / dt : 0;
    const dismiss =
      !cancelled && (along > g.size * DRAG_DISMISS_SHARE || velocity > DRAG_DISMISS_VELOCITY);
    const target = dismiss ? g.size : 0;
    dismissing.current = dismiss;
    setOffset(target);
    if (reducedMotion() || target === along) {
      // Snap with no animation (reduced motion), or nothing left to travel.
      finish();
    } else {
      setState("settling");
    }
  };

  const shown = state === "idle" ? 0 : offset;
  const share = size > 0 ? Math.min(shown / size, 1) : 0;
  const translate = axis === "y" ? "translateY" : "translateX";
  const style: CSSProperties | undefined =
    state === "idle" ? undefined : { transform: `${translate}(${shown * direction}px)` };

  return {
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e) => end(e, false),
      onPointerCancel: (e) => end(e, true),
    },
    panelProps: {
      "data-state": state,
      style,
      onTransitionEnd: (e) => {
        if (e.target === e.currentTarget && state === "settling") finish();
      },
    },
    scrimProps: {
      "data-drag": state,
      style: state === "idle" ? undefined : { opacity: 1 - share },
    },
    state,
    offset: shown,
    share,
  };
}
