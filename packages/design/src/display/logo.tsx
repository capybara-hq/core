// spec §3：14×10 位图，X 实心，O 眼睛镂空。原样复制。
export const CAPYBARA_BITMAP: readonly string[] = [
  "..........X...",
  ".........XXX..",
  "...XXXXXXXXXXX",
  "..XXXXXXXXXOXX",
  ".XXXXXXXXXXXXX",
  ".XXXXXXXXXXXXX",
  ".XXXXXXXXXXXX.",
  "..XXXXXXXXXX..",
  "..XX..X..XX...",
  "..XX..X..XX...",
];

const COLS = 14;
const ROWS = 10;

/**
 * The `X` cells of bitmap `rows` as one SVG path of `scale`-sized squares, the first row drawn
 * at row `top` (the logo, the working line's mark and its leg frames).
 */
export function bitmapCells(rows: readonly string[], scale: number, top = 0): string {
  const out: string[] = [];
  rows.forEach((row, i) => {
    const y = top + i;
    for (let x = 0; x < row.length; x++)
      if (row[x] === "X") out.push(`M${x * scale} ${y * scale}h${scale}v${scale}h${-scale}z`);
  });
  return out.join("");
}

export function Logo({
  scale = 3,
  tone = "accent",
  wordmark,
}: {
  scale?: 2 | 3 | 6;
  tone?: "accent" | "muted";
  wordmark?: boolean;
}) {
  return (
    <span className="cb-logo" data-tone={tone}>
      <svg
        width={COLS * scale}
        height={ROWS * scale}
        viewBox={`0 0 ${COLS * scale} ${ROWS * scale}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
      >
        <path d={bitmapCells(CAPYBARA_BITMAP, scale)} />
      </svg>
      {wordmark ? <span className="cb-logo-word">CAPYBARA</span> : null}
    </span>
  );
}

/**
 * The pixel capybara as a line drawing (the empty state's illustration, spec §6.18): the outer
 * edges of the bitmap's cells, the eye included, stroked 1 px in `faint`. Decorative.
 */
export function LogoLine({ scale = 6 }: { scale?: 3 | 4 | 6 }) {
  const filled = (x: number, y: number) => CAPYBARA_BITMAP[y]?.[x] === "X";
  const segs: string[] = [];
  CAPYBARA_BITMAP.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!filled(x, y)) continue;
      const l = x * scale + 0.5;
      const t = y * scale + 0.5;
      const r = l + scale;
      const b = t + scale;
      if (!filled(x, y - 1)) segs.push(`M${l} ${t}H${r}`);
      if (!filled(x, y + 1)) segs.push(`M${l} ${b}H${r}`);
      if (!filled(x - 1, y)) segs.push(`M${l} ${t}V${b}`);
      if (!filled(x + 1, y)) segs.push(`M${r} ${t}V${b}`);
    }
  });
  const w = COLS * scale + 1;
  const h = ROWS * scale + 1;
  return (
    <svg
      className="cb-logo-line"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={segs.join("")} />
    </svg>
  );
}
