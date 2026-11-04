import { type JSX, useEffect, useState } from "react";
import { bitmapCells, CAPYBARA_BITMAP } from "../display/logo";
import type { DesignKey } from "../i18n";
import { useDesignT } from "../provider";

/** The captions in rotation order (§6.16.24); the first is the one announced. */
const CAPTIONS: readonly DesignKey[] = [
  "working.plan",
  "working.act",
  "working.ponder",
  "working.compose",
];

/** The second walking frame's legs (rows 9–10 of the §3 bitmap): each pair one pixel inward. */
const LEGS_2: readonly string[] = ["...XX.X.XX....", "...XX.X.XX...."];

const BODY_ROWS = 8;

const BODY = bitmapCells(CAPYBARA_BITMAP.slice(0, BODY_ROWS), 1);
const FRAME_1 = bitmapCells(CAPYBARA_BITMAP.slice(BODY_ROWS), 1, BODY_ROWS);
const FRAME_2 = bitmapCells(LEGS_2, 1, BODY_ROWS);

export type WorkingLineProps = {
  /** Draws the reduced-motion form whatever the system says (the reference set's state). */
  still?: boolean;
  /**
   * The line shows (default). Off, only its live region stays mounted, empty, so the next start
   * is announced (`ConversationPage` keeps it mounted this way).
   */
  active?: boolean;
};

/**
 * The working line (§6.16.24): from a person's send until the run's first output, the pixel
 * capybara walking (two leg frames, 400 ms apart) and a caption rotating every 2.4 s. Both are CSS
 * animations, so reduced motion (or `still`) leaves frame 1 and the first caption. A status
 * announced once: a polite status region, kept mounted, is filled with the first caption after
 * the line starts (a region filled as it is inserted may not be read); the line itself and its
 * rotating captions are hidden from assistive tech. No timer.
 */
export function WorkingLine({ still, active = true }: WorkingLineProps): JSX.Element {
  const t = useDesignT();
  const [said, setSaid] = useState(false);
  useEffect(() => setSaid(active), [active]);
  return (
    <>
      <div className="cb-sr-only" role="status" data-part="working-status">
        {active && said ? t(CAPTIONS[0] as DesignKey) : ""}
      </div>
      {active ? <WorkingLineBody still={still === true} /> : null}
    </>
  );
}

function WorkingLineBody({ still }: { still: boolean }): JSX.Element {
  const t = useDesignT();
  return (
    <div
      className="cb-tool-line cb-working-line"
      data-part="working-line"
      aria-hidden="true"
      data-still={still ? "true" : undefined}
    >
      <span className="cb-working-mark" data-part="working-mark" aria-hidden="true">
        <svg
          width={14}
          height={10}
          viewBox="0 0 14 10"
          shapeRendering="crispEdges"
          aria-hidden="true"
          focusable="false"
        >
          <path d={BODY} />
          <path d={FRAME_1} data-frame="1" />
          <path d={FRAME_2} data-frame="2" />
        </svg>
      </span>
      <span
        className="cb-tool-label cb-working-caption"
        data-part="working-caption"
        aria-hidden="true"
      >
        {CAPTIONS.map((k) => (
          <span key={k}>{t(k)}</span>
        ))}
      </span>
    </div>
  );
}
