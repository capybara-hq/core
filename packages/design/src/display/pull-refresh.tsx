import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons/icon";
import { useHaptics, useNative } from "../native";
import { useDesignT } from "../provider";

/** The pull distance (px of finger travel, after damping) that triggers a refresh. */
export const PULL_THRESHOLD = 64;
/** The indicator never travels further than this. */
const PULL_MAX = 96;
/** The finger travels this much for one px of indicator. */
const DAMPING = 0.5;

type PullRefreshProps = {
  /** Reads the data again; the indicator spins until the promise settles. */
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
};

/** The nearest ancestor that scrolls vertically (the template root on compact), else the page. */
function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Pull to refresh (interaction spec §3, D4): only in a native shell (its handlers reach the design
 * through `DesignProvider native`, never the user agent), where a pull down from the top of the
 * scroller reads the data again. The browser keeps its own pull-to-reload: without a shell the
 * children render untouched and no listener is added. The listeners are passive: the scroller's
 * own overscroll bounce plays and the indicator rides on top. A pull counts only when the
 * scroller starts at its top; passing the threshold plays the `selection` haptic and calls
 * `onRefresh`; the spinner stays until it settles.
 */
export function PullToRefresh({ onRefresh, children }: PullRefreshProps) {
  const active = useNative() !== null;
  if (!active) return <>{children}</>;
  return <Active onRefresh={onRefresh}>{children}</Active>;
}

function Active({ onRefresh, children }: PullRefreshProps) {
  const t = useDesignT();
  const haptics = useHaptics();
  const ref = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [pending, setPending] = useState(false);
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
    if (el === null) return;
    let start: { y: number; scroller: Element } | null = null;
    const down = (e: TouchEvent) => {
      const touch = e.touches[0];
      start = null;
      pulled.current = 0;
      if (e.touches.length !== 1 || touch === undefined) return;
      const scroller = scrollerOf(el);
      if (scroller.scrollTop > 0) return;
      start = { y: touch.clientY, scroller };
    };
    const move = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (start === null || touch === undefined) return;
      const dy = touch.clientY - start.y;
      if (dy <= 0 || start.scroller.scrollTop > 0) {
        if (pulled.current !== 0) {
          pulled.current = 0;
          setPull(0);
        }
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
  }, [finish]);

  const shown = pending ? PULL_THRESHOLD : pull;
  return (
    <div className="cb-pullrefresh" data-part="pull-refresh" ref={ref}>
      {shown > 0 ? (
        <div
          className="cb-pullrefresh-indicator"
          data-part="pull-indicator"
          data-pending={pending ? "true" : undefined}
          data-ready={pull >= PULL_THRESHOLD ? "true" : undefined}
          role="status"
          style={{ transform: `translateY(${shown}px)` }}
        >
          <Icon name="spinner" size={16} />
          <span className="cb-pullrefresh-label">
            {t(pending ? "pullRefresh.refreshing" : "pullRefresh.pull")}
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
}
