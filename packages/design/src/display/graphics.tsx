// 32 位整数哈希（确定性），返回 [0,1)。
function hash(a: number, b: number, c: number): number {
  let h =
    (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)) >>>
    0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const CELL = 4;
const D_COLS = 24;
const D_ROWS = 120;

export function Dither({ side, seed = 1 }: { side: "left" | "right"; seed?: number }) {
  const rects: { x: number; y: number; accent: boolean }[] = [];
  for (let r = 0; r < D_ROWS; r++) {
    for (let c = 0; c < D_COLS; c++) {
      // 密度由外侧向内侧递减
      const dist = side === "left" ? c : D_COLS - 1 - c;
      const density = (1 - dist / D_COLS) ** 2 * 0.7;
      if (hash(seed, c, r) < density) rects.push({ x: c * CELL, y: r * CELL, accent: false });
    }
  }
  // 点缀主色 ≤1%
  const cap = Math.floor(rects.length * 0.01);
  const picks = rects
    .map((_, i) => ({ i, k: hash(seed + 101, i, 7) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, cap);
  for (const p of picks) (rects[p.i] as { accent: boolean }).accent = true;
  return (
    <svg
      className="cb-dither"
      data-side={side}
      width={D_COLS * CELL}
      height={D_ROWS * CELL}
      viewBox={`0 0 ${D_COLS * CELL} ${D_ROWS * CELL}`}
      preserveAspectRatio={side === "left" ? "xMinYMin slice" : "xMaxYMin slice"}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x}
          y={r.y}
          width={CELL}
          height={CELL}
          data-accent={r.accent ? "true" : undefined}
        />
      ))}
    </svg>
  );
}

export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="cb-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位行
        <div key={i} className="cb-skeleton-row" />
      ))}
    </div>
  );
}

const BLOCK = 4;
const GAP = 1;
const MAX_ROWS = 12;

export function BarChart({
  series,
  current,
  label,
}: {
  series: { value: number; fail?: number }[];
  current?: number;
  label: string;
}) {
  const max = Math.max(1, ...series.map((s) => s.value));
  const step = BLOCK + GAP;
  const width = series.length * step - GAP;
  const height = MAX_ROWS * step - GAP;
  const blocks: { key: string; x: number; y: number; kind: string }[] = [];
  series.forEach((s, i) => {
    const total = s.value > 0 ? Math.max(1, Math.round((s.value / max) * MAX_ROWS)) : 0;
    const fails = Math.min(total, s.fail ? Math.max(1, Math.round((s.fail / max) * MAX_ROWS)) : 0);
    for (let k = 0; k < total; k++) {
      const kind = k >= total - fails ? "fail" : i === current ? "current" : "normal";
      blocks.push({
        key: `${i}-${k}`,
        x: i * step,
        y: height - (k + 1) * step + GAP,
        kind,
      });
    }
  });
  return (
    <svg
      className="cb-barchart"
      role="img"
      aria-label={label}
      width={Math.max(width, 0)}
      height={height}
      viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
      shapeRendering="crispEdges"
    >
      {blocks.map((b) => (
        <rect key={b.key} x={b.x} y={b.y} width={BLOCK} height={BLOCK} data-kind={b.kind} />
      ))}
    </svg>
  );
}
