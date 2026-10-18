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

export function Logo({
  scale = 3,
  tone = "accent",
  wordmark,
}: {
  scale?: 2 | 3 | 6;
  tone?: "accent" | "muted";
  wordmark?: boolean;
}) {
  const cells: string[] = [];
  CAPYBARA_BITMAP.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "X") cells.push(`M${x * scale} ${y * scale}h${scale}v${scale}h${-scale}z`);
    }
  });
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
        <path d={cells.join("")} />
      </svg>
      {wordmark ? <span className="cb-logo-word">CAPYBARA</span> : null}
    </span>
  );
}
