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

// 柱状图几何（与设计稿一致）：每列 32 个单位宽，柱宽 26、列间 6；方块高 8、块间 2。
// 横向按 viewBox 拉伸撑满容器（preserveAspectRatio="none"），纵向不缩放。
const COL = 32;
const BAR = 26;
const BLOCK_H = 8;
const ROW = 10;

export function BarChart({
  series,
  current,
  label,
  height = 120,
}: {
  series: { value: number; fail?: number }[];
  current?: number;
  label: string;
  /** 像素高，默认 120。 */
  height?: number;
}) {
  const max = Math.max(1, ...series.map((s) => s.value));
  const maxRows = Math.max(1, Math.floor((height + ROW - BLOCK_H) / ROW));
  const width = Math.max(series.length * COL - (COL - BAR), 1);
  const blocks: { key: string; x: number; y: number; kind: string }[] = [];
  series.forEach((s, i) => {
    const total = s.value > 0 ? Math.max(1, Math.round((s.value / max) * maxRows)) : 0;
    const fails = Math.min(total, s.fail ? Math.max(1, Math.round((s.fail / max) * maxRows)) : 0);
    for (let k = 0; k < total; k++) {
      const kind = k >= total - fails ? "fail" : i === current ? "current" : "normal";
      blocks.push({ key: `${i}-${k}`, x: i * COL, y: height - BLOCK_H - k * ROW, kind });
    }
  });
  return (
    <svg
      className="cb-barchart"
      role="img"
      aria-label={label}
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
    >
      {blocks.map((b) => (
        <rect key={b.key} x={b.x} y={b.y} width={BAR} height={BLOCK_H} data-kind={b.kind} />
      ))}
    </svg>
  );
}

// 迷你趋势（spec §6.8）：12 根 4px 宽方柱，间距 2，高 14，muted。
const SPARK_BARS = 12;
const SPARK_W = 4;
const SPARK_GAP = 2;
const SPARK_H = 14;

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const vs = values.slice(-SPARK_BARS);
  const max = Math.max(0, ...vs);
  const width = SPARK_BARS * (SPARK_W + SPARK_GAP) - SPARK_GAP;
  const offset = (SPARK_BARS - vs.length) * (SPARK_W + SPARK_GAP);
  return (
    <svg
      className="cb-sparkline"
      role="img"
      aria-label={label}
      width={width}
      height={SPARK_H}
      viewBox={`0 0 ${width} ${SPARK_H}`}
      shapeRendering="crispEdges"
    >
      {vs.map((v, i) => {
        // 高度取 2 的倍数，2–12
        const h = 2 + Math.round((max > 0 ? Math.max(0, v) / max : 0) * 5) * 2;
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定位置的柱
            key={i}
            x={offset + i * (SPARK_W + SPARK_GAP)}
            y={SPARK_H - h}
            width={SPARK_W}
            height={h}
          />
        );
      })}
    </svg>
  );
}
