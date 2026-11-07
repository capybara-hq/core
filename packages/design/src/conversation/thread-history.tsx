import { type JSX, useEffect, useRef } from "react";
import { SkeletonText } from "../display/skeleton";
import { useDesignT } from "../provider";

/**
 * The thread's top edge while its history loads in pages (spec §5.4 "Thread scrolling"): `more`
 * (earlier messages are not loaded), `loading` (the previous page is on its way), `failed` (its
 * read failed) or `start` (the beginning of the conversation is loaded).
 */
export type ThreadHistoryState = "more" | "loading" | "failed" | "start";

export type ThreadHistoryProps = {
  state: ThreadHistoryState;
  /** Reads the previous page: when the edge nears the view, on the link, or Retry. */
  onLoadEarlier(): void;
};

/** How far above the visible area the edge starts the next read (px). */
const LOOKAHEAD = 600;

/** The nearest scrolling ancestor (the observer's root), else the viewport. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return null;
}

/**
 * The top of a thread whose history loads in pages. `more`: a link that reads the previous page,
 * and an observed edge that reads it on its own once it comes within 600 px of the visible area
 * (the observer is made again on every state change, so a page that leaves the edge in range
 * reads the next one). `loading`: a placeholder turn and a polite status. `failed`: a fail
 * divider with Retry. `start`: the divider "Beginning of conversation". Its parts reuse the run
 * divider (§6.16.7) and the thread's loading turn, so it has no look of its own.
 */
export function ThreadHistory({ state, onLoadEarlier }: ThreadHistoryProps): JSX.Element {
  const t = useDesignT();
  const edge = useRef<HTMLDivElement>(null);
  const load = useRef(onLoadEarlier);
  load.current = onLoadEarlier;
  useEffect(() => {
    const el = edge.current;
    if (state !== "more" || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) load.current();
      },
      { root: scrollParent(el), rootMargin: `${LOOKAHEAD}px 0px 0px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [state]);
  if (state === "loading") {
    return (
      <div data-part="thread-history" data-state="loading" aria-busy="true">
        <div className="cb-sr-only" role="status">
          {t("conv.historyLoading")}
        </div>
        <SkeletonText width="70%" size="prose" />
      </div>
    );
  }
  const fail = state === "failed";
  return (
    <div ref={edge} data-part="thread-history" data-state={state} className="cb-run-divider-wrap">
      <div
        className="cb-run-divider"
        data-tone={fail ? "fail" : undefined}
        role={fail ? "alert" : undefined}
      >
        <span className="cb-divider-rule" data-part="divider-rule" />
        <span className="cb-run-divider-text">
          {state === "start" ? (
            t("conv.historyStart")
          ) : fail ? (
            <>
              {t("conv.historyFailed")}
              {" ·"}
              <button
                type="button"
                className="cb-link-btn"
                data-tone="fail"
                onClick={onLoadEarlier}
              >
                {t("conv.retry")}
              </button>
            </>
          ) : (
            <button type="button" className="cb-link-btn" onClick={onLoadEarlier}>
              {t("conv.historyMore")}
            </button>
          )}
        </span>
        <span className="cb-divider-rule" data-part="divider-rule" />
      </div>
    </div>
  );
}
