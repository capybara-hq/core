import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons/icon";
import { useHaptics } from "../native";
import { useDesignT } from "../provider";
import { useShellKind } from "../shell/shell-environment";
import { useTouch } from "../shell/touch";

/** The pull distance (px of finger travel, after damping) that triggers a refresh. */
export const PULL_THRESHOLD = 64;
/** The indicator never travels further than this. */
const PULL_MAX = 96;
/** The finger travels this much for one px of indicator. */
const DAMPING = 0.5;
/** Finger travel (px) before the drag's axis is decided. */
const AXIS_SLOP = 8;

type PullRefreshProps = {
  /** Reads the data again; the indicator spins until the promise settles. */
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
};

function scrolls(el: Element): boolean {
  const oy = getComputedStyle(el).overflowY;
  return oy === "auto" || oy === "scroll";
}

/**
 * Every vertical scroller from `target` up to the page, innermost first, and the page's own
 * scroller last: a pull counts only when all of them are at their top (the inbox's list pane
 * scrolls inside a template that does not).
 */
function scrollersOf(target: Element): Element[] {
  const out: Element[] = [];
  for (let p: Element | null = target; p !== null; p = p.parentElement) {
    if (scrolls(p)) out.push(p);
  }
  const page = document.scrollingElement ?? document.documentElement;
  if (!out.includes(page)) out.push(page);
  return out;
}

const atTop = (scrollers: readonly Element[]) => scrollers.every((s) => s.scrollTop <= 0);

/**
 * Pull to refresh (interaction spec §3, D4): only in the native mobile shell (the shell's declared
 * `kind`, read from `window.capybaraShell` like the shell environment; never the user agent) on a
 * touch device, where a pull down from the top reads the data again. The browser keeps its own
 * pull-to-reload and the desktop shell has none: there no listener is added and nothing is drawn.
 * The wrapper (no box) is always there, so turning active after hydration never remounts the
 * list. The listeners are passive: the scroller's own overscroll bounce plays and the indicator
 * rides on top. A pull counts only when every scroller under the finger starts at its top and the
 * drag is more vertical than horizontal; past the threshold the indicator says "release"; letting
 * go there plays the `selection` haptic and calls `onRefresh`; the spinner stays until it settles.
 */
export function PullToRefresh({ onRefresh, children }: PullRefreshProps) {
  const shell = useShellKind() === "mobile";
  const touch = useTouch() === true;
  const active = shell && touch;
  const t = useDesignT();
  const haptics = useHaptics();
  const ref = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [pending, setPending] = useState(false);
  // where the indicator hangs: the top centre of the innermost scroller under the finger
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const latest = useRef({ onRefresh, haptics, pending });
  latest.current = { onRefresh, haptics, pending };
  const pulled = useRef(0);

  const finish = useCallback(() => {
    const was = pulled.current;
    pulled.current = 0;
    setPull(0);
    if (was < PULL_THRESHOLD || latest.current.pending) return;
    latest.current.haptics("selection");
    setPending(true);
    const done = () => setPending(false);
    try {
      void Promise.resolve(latest.current.onRefresh()).then(done, done);
    } catch {
      done();
    }
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!active || el === null) return;
    let start: { x: number; y: number; scrollers: Element[]; vertical: boolean } | null = null;
    const reset = () => {
      if (pulled.current !== 0) {
        pulled.current = 0;
        setPull(0);
      }
    };
    const down = (e: TouchEvent) => {
      const touch = e.touches[0];
      start = null;
      pulled.current = 0;
      if (e.touches.length !== 1 || touch === undefined || !(e.target instanceof Element)) return;
      const scrollers = scrollersOf(e.target);
      if (!atTop(scrollers)) return;
      start = { x: touch.clientX, y: touch.clientY, scrollers, vertical: false };
      const r = (scrollers[0] as Element).getBoundingClientRect();
      setAnchor({ top: Math.max(r.top, 0), left: r.left + r.width / 2 });
    };
    const move = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (start === null || touch === undefined) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!start.vertical) {
        // axis lock: a sideways drag (a swipe on a row, a carousel) is never a pull
        if (Math.abs(dx) > Math.abs(dy)) {
          if (Math.abs(dx) >= AXIS_SLOP) {
            start = null;
            reset();
          }
          return;
        }
        if (Math.abs(dy) >= AXIS_SLOP) start.vertical = true;
      }
      if (dy <= 0 || !atTop(start.scrollers)) {
        reset();
        return;
      }
      pulled.current = Math.min(dy * DAMPING, PULL_MAX);
      setPull(pulled.current);
    };
    const end = () => {
      if (start === null) return;
      start = null;
      finish();
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [active, finish]);

  const shown = pending ? PULL_THRESHOLD : pull;
  const ready = !pending && pull >= PULL_THRESHOLD;
  const label = pending
    ? "pullRefresh.refreshing"
    : ready
      ? "pullRefresh.release"
      : "pullRefresh.pull";
  return (
    <div className="cb-pullrefresh" data-part="pull-refresh" ref={ref}>
      {/* always mounted while active, so the announcement of a refresh is heard */}
      {active ? (
        <span className="cb-sr-only" role="status">
          {pending ? t("pullRefresh.refreshing") : ""}
        </span>
      ) : null}
      {active && shown > 0
        ? // in the body: a container-type ancestor would otherwise hold the fixed indicator
          createPortal(
            <div
              className="cb-pullrefresh-indicator"
              data-part="pull-indicator"
              data-pending={pending ? "true" : undefined}
              data-ready={ready ? "true" : undefined}
              aria-hidden
              style={{
                top: anchor.top,
                left: anchor.left,
                transform: `translate(-50%, ${shown}px)`,
              }}
            >
              <Icon name="spinner" size={16} />
              <span className="cb-pullrefresh-label">{t(label)}</span>
            </div>,
            document.body,
          )
        : null}
      {children}
    </div>
  );
}
