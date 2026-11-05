import { type JSX, useLayoutEffect, useRef, useState } from "react";
import { bitmapCells, CAPYBARA_BITMAP } from "../display/logo";
import { useDesignT } from "../provider";

/** One character every 40 ms (agent profile design §4.1). */
export const GREETING_TYPE_MS = 40;

/** The pixel unit: 2, the 14×10 bitmap at 28×20, as the working line's mark (§6.16.24). */
const UNIT = 2;
const MARK = bitmapCells(CAPYBARA_BITMAP, UNIT);

export type GreetingProps = {
  /**
   * The greeting line. Absent (the server render and the first client render, while the page
   * picks the line on the client), the line's box holds an empty placeholder of the same height.
   */
  text?: string | null;
  /** The line below; default 「选一个 agent，或从常用任务开始」; `null` draws none. */
  sub?: string | null;
  /** Draws the reduced-motion form whatever the system says (the reference set's state). */
  still?: boolean;
};

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The greeting of a new conversation (§6.16.25, agent profile design §4.1): the pixel capybara
 * and one line, typed once at 40 ms a character with an `accent` caret; reduced motion (or
 * `still`) shows it whole. The heading reads the whole line once (a visually hidden copy); the
 * typed text is hidden from assistive tech, so no character is announced.
 */
export function Greeting({ text, sub, still }: GreetingProps): JSX.Element {
  const t = useDesignT();
  const chars = text ? Array.from(text) : [];
  const [shown, setShown] = useState(0);
  // The line that has been typed to the end: a re-render (or a second mount effect in strict
  // mode, which restarts the typing) never types it again once it is complete.
  const done = useRef<string | null>(null);
  const length = chars.length;
  useLayoutEffect(() => {
    if (!text) return;
    if (still || reducedMotion() || done.current === text) {
      done.current = text;
      setShown(length);
      return;
    }
    setShown(0);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= length) {
        done.current = text;
        clearInterval(id);
      }
    }, GREETING_TYPE_MS);
    return () => clearInterval(id);
  }, [text, length, still]);
  const typing = shown < length;
  const subLine = sub === undefined ? t("greeting.sub") : sub;
  return (
    <div className="cb-greeting" data-part="greeting">
      <div className="cb-greeting-line" data-part="greeting-line">
        <span className="cb-greeting-mark" data-part="greeting-mark" aria-hidden="true">
          <svg
            width={14 * UNIT}
            height={10 * UNIT}
            viewBox={`0 0 ${14 * UNIT} ${10 * UNIT}`}
            shapeRendering="crispEdges"
            aria-hidden="true"
            focusable="false"
          >
            <path d={MARK} />
          </svg>
        </span>
        {text ? (
          <h2 className="cb-greeting-text" data-part="greeting-text">
            <span className="cb-sr-only">{text}</span>
            <span aria-hidden="true" data-part="greeting-typed">
              {chars.slice(0, shown).join("")}
              {typing ? <span className="cb-greeting-caret" data-part="greeting-caret" /> : null}
            </span>
          </h2>
        ) : (
          <span className="cb-greeting-text" data-part="greeting-placeholder" aria-hidden="true" />
        )}
      </div>
      {subLine ? (
        <p className="cb-greeting-sub" data-part="greeting-sub">
          {subLine}
        </p>
      ) : null}
    </div>
  );
}
