import type { JSX } from "react";
import { CAPYBARA_BITMAP } from "../display/logo";
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

/** Unit squares of the `X` cells of `rows`, the first row drawn at `top`. */
function cells(rows: readonly string[], top: number): string {
  const out: string[] = [];
  rows.forEach((row, i) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "X") out.push(`M${x} ${top + i}h1v1h-1z`);
  });
  return out.join("");
}

const BODY = cells(CAPYBARA_BITMAP.slice(0, BODY_ROWS), 0);
const FRAME_1 = cells(CAPYBARA_BITMAP.slice(BODY_ROWS), BODY_ROWS);
const FRAME_2 = cells(LEGS_2, BODY_ROWS);

export type WorkingLineProps = {
  /** Draws the reduced-motion form whatever the system says (the reference set's state). */
  still?: boolean;
};

/**
 * The working line (§6.16.24): from a person's send until the run's first output, the pixel
 * capybara walking (two leg frames, 400 ms apart) and a caption rotating every 2.4 s. Both are CSS
 * animations, so reduced motion (or `still`) leaves frame 1 and the first caption. A status
 * announced once: the rotating captions are hidden from assistive tech, a hidden copy of the
 * first one is what is read. No timer.
 */
export function WorkingLine({ still }: WorkingLineProps): JSX.Element {
  const t = useDesignT();
  return (
    <div
      className="cb-tool-line cb-working-line"
      data-part="working-line"
      role="status"
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
      <span className="cb-sr-only">{t(CAPTIONS[0] as DesignKey)}</span>
    </div>
  );
}
