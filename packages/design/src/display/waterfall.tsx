import { type KeyboardEvent, useId } from "react";
import { useDesignT } from "../provider";
import { type Status, StatusMark } from "./basic";

/** 瀑布图里的一个 span（spec §6.10）：层级由 `parentId` 给出，调用方按深度优先顺序传入。 */
export interface Span {
  id: string;
  parentId?: string;
  kind: "run" | "step" | "model" | "tool" | "wait";
  label: string;
  /** 相对最早 span 的偏移（毫秒）。 */
  startMs: number;
  /** 未知（未结束 / 未记录）为 null。 */
  durationMs: number | null;
  status: "ok" | "error" | "pending";
  /** 名称后的补充（如 token 数）。 */
  meta?: string;
}

export interface SpanWaterfallProps {
  spans: Span[];
  selectedId: string | null;
  onSelect(id: string): void;
  /** `empty`：空列表文案；`kinds`：kind 徽标文案（缺省取 design 的 `waterfall.kind.*`）。 */
  labels: { empty: string; kinds?: Partial<Record<Span["kind"], string>> };
  /** 列表的可访问名称；缺省「Span 瀑布」。 */
  label?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 耗时（spec §7）：`312ms` / `6.8s` / `41.2s` / `00:02:18`；未知为 `—`。 */
export function formatSpanDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const statusOf = (s: Span): Status =>
  s.status === "ok"
    ? "success"
    : s.status === "error"
      ? "failed"
      : s.kind === "wait"
        ? "waiting"
        : "running";

/** 百分比（保留两位小数，去掉多余的 0）。 */
const pct = (v: number) => `${Number((v * 100).toFixed(2))}%`;

/** Span 瀑布（spec §6.10）：tree（总是展开），每行名称列 + 时间轨 + 状态 + 耗时。 */
export function SpanWaterfall({ spans, selectedId, onSelect, labels, label }: SpanWaterfallProps) {
  const t = useDesignT();
  const base = useId();
  if (spans.length === 0) {
    return (
      <div className="cb-waterfall-empty">
        <span className="cb-text" data-variant="body" data-tone="muted">
          {labels.empty}
        </span>
      </div>
    );
  }
  const depth = new Map<string, number>();
  for (const s of spans) {
    depth.set(s.id, s.parentId === undefined ? 0 : (depth.get(s.parentId) ?? -1) + 1);
  }
  /** 有子 span 的节点（tree 里总是展开）。 */
  const parents = new Set(spans.flatMap((s) => (s.parentId === undefined ? [] : [s.parentId])));
  const total = Math.max(1, ...spans.map((s) => s.startMs + (s.durationMs ?? 0)));
  const rowId = (i: number) => `${base}-span-${i}`;
  const selectedIndex = spans.findIndex((s) => s.id === selectedId);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = spans.length - 1;
    const at = selectedIndex;
    const to =
      e.key === "ArrowDown"
        ? Math.min(last, at + 1)
        : e.key === "ArrowUp"
          ? Math.max(0, at === -1 ? 0 : at - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    const target = spans[to];
    if (target) onSelect(target.id);
  };

  return (
    <div
      className="cb-waterfall"
      role="tree"
      tabIndex={0}
      aria-label={label ?? t("waterfall.label")}
      aria-activedescendant={selectedIndex === -1 ? undefined : rowId(selectedIndex)}
      onKeyDown={onKeyDown}
    >
      {spans.map((s, i) => {
        const d = Math.max(0, depth.get(s.id) ?? 0);
        const open = s.durationMs === null && s.status === "pending";
        const left = Math.min(1, Math.max(0, s.startMs / total));
        const width = open
          ? 1 - left
          : Math.min(1 - left, Math.max(0, (s.durationMs ?? 0) / total));
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘由 tree 统一处理（↑ / ↓ / Home / End）
          <div
            key={s.id}
            id={rowId(i)}
            className="cb-waterfall-row"
            role="treeitem"
            tabIndex={-1}
            aria-selected={s.id === selectedId}
            aria-level={d + 1}
            aria-expanded={parents.has(s.id) ? true : undefined}
            data-span={s.id}
            data-kind={s.kind}
            data-status={s.status}
            data-open={open ? "true" : undefined}
            onClick={() => onSelect(s.id)}
          >
            <div className="cb-waterfall-name" style={{ paddingLeft: d * 16 }}>
              <span className="cb-waterfall-kind">
                {labels.kinds?.[s.kind] ?? t(`waterfall.kind.${s.kind}`)}
              </span>
              <span className="cb-waterfall-label" title={s.label}>
                {s.label}
              </span>
              {s.meta !== undefined ? <span className="cb-waterfall-meta">{s.meta}</span> : null}
            </div>
            <div className="cb-waterfall-track" aria-hidden="true">
              <span className="cb-waterfall-bar" style={{ left: pct(left), width: pct(width) }} />
            </div>
            <div className="cb-waterfall-status">
              <StatusMark status={statusOf(s)} />
            </div>
            <div className="cb-waterfall-ms">{formatSpanDuration(s.durationMs)}</div>
          </div>
        );
      })}
    </div>
  );
}
