import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { useDensity } from "../controls/density";
import { useDesignT } from "../provider";

/** One measure of a TrendChart: its own panel and its own scale (never a second y-axis). */
export type TrendChartPanel = {
  id: string;
  /** The panel title (运行 / Token); it names the one series, so there is no legend. */
  label: string;
  /** One value per x position; `null` is no data, drawn as a gap. */
  values: (number | null)[];
  /** Formats the axis max, the latest value, the tooltip, the summary and the table. */
  format(n: number): string;
};

export type TrendChartProps = {
  /** The accessible name of the chart (「近 7 天用量」). */
  label: string;
  /** The x positions in order (the dates), shared by every panel. */
  x: { key: string; label: string }[];
  /** The measures, one stacked panel each (small multiples, spec §6.8). */
  panels: TrendChartPanel[];
  /** The index drawn in `accent` (today), with the segment into it. */
  current?: number;
  /** More tooltip lines for a position (估算 ¥12.30); also a column of the hidden table. */
  extra?(i: number): ReactNode;
  /** The hidden table's header of the `extra` column (估算费用). */
  extraLabel?: string;
  /** The zero state's line, shown when no value of any panel is above zero. */
  empty?: string;
  /** The index shown with the crosshair and tooltip before any pointer or key moves it. */
  defaultActive?: number;
};

/** Plot heights by density step (spec §2.5: 96 at `default`, 72 at `dense`). */
const PLOT_H = { default: 96, dense: 72 } as const;
/** Room above the highest point for the max label (`type.small` line + the marker's half). */
const TOP = 20;
/** The baseline sits the marker's half (and one) above the plot's bottom. */
const BOTTOM_GAP = 4;
/** Square point markers, 6 px, centred on the value. */
const MARK = 6;

/** The x centre of column `i` of `n`, in % of the plot width. */
function cx(i: number, n: number): number {
  return Number((((i + 0.5) / n) * 100).toFixed(4));
}

/** The latest value of a panel: the current one when it has a value, else the last value. */
function latestIndex(values: (number | null)[], current: number | undefined): number | null {
  if (current !== undefined && values[current] != null) return current;
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return null;
}

function fill(template: string, args: Record<string, string>): string {
  return Object.entries(args).reduce((s, [k, v]) => s.replace(`{${k}}`, v), template);
}

/**
 * A time series as small multiples (spec §6.8; admin overview design §10.1): one panel per
 * measure, stacked, sharing the x-axis (labels under the last panel), one crosshair and one
 * tooltip. Never a second y-scale (D1). The chart is one focusable group: ←/→ move the point,
 * Home/End jump, Esc hides; the tooltip text is mirrored in a polite live region and every value
 * is in a visually hidden table.
 */
export function TrendChart({
  label,
  x,
  panels,
  current,
  extra,
  extraLabel,
  empty,
  defaultActive,
}: TrendChartProps) {
  const t = useDesignT();
  const density = useDensity() === "dense" ? "dense" : "default";
  const h = PLOT_H[density];
  const bottom = h - BOTTOM_GAP;
  const n = x.length;
  const [active, setActive] = useState<number | null>(defaultActive ?? null);
  const [last, setLast] = useState<number | null>(defaultActive ?? null);
  // whether the shown point was reached by keyboard (focus or keys): only then is it announced
  // and does it outlive the pointer leaving
  const [byKey, setByKey] = useState(false);
  const pointerDown = useRef(false);

  const isEmpty = panels.every((p) => p.values.every((v) => v == null || v <= 0));
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const show = (i: number | null) => {
    setActive(i);
    if (i !== null) setLast(i);
  };

  const xLabel = (i: number) =>
    `${x[i]?.label ?? ""}${i === current ? t("trendChart.current") : ""}`;
  const valueText = (p: TrendChartPanel, i: number) => {
    const v = p.values[i];
    return v == null ? "—" : p.format(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const from = active ?? last ?? current ?? n - 1;
    let next: number | null;
    switch (e.key) {
      case "ArrowLeft":
        next = clamp(from - 1);
        break;
      case "ArrowRight":
        next = clamp(from + 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case "Escape":
        if (active === null) return;
        e.preventDefault();
        setActive(null);
        return;
      default:
        return;
    }
    e.preventDefault();
    setByKey(true);
    show(next);
  };

  const onPointerLeave = (e: PointerEvent<HTMLDivElement>) => {
    // a tapped column stays after the finger lifts (pointerleave follows every touch)
    if (e.pointerType === "touch") return;
    // a point reached by keyboard stays; a clicked group's focus does not keep it
    if (byKey) return;
    setActive(null);
  };

  const columns = { gridTemplateColumns: `repeat(${Math.max(n, 1)}, minmax(0, 1fr))` };
  // label every position, or every k-th from the last when they are many (they stay readable)
  const step = Math.max(1, Math.ceil(n / 8));

  let tooltip: ReactNode = null;
  let liveText: ReactNode = null;
  if (active !== null && active < n) {
    const at = cx(active, n);
    const side: CSSProperties =
      at <= 50
        ? { left: `calc(${at}% + var(--cb-space-2))` }
        : { right: `calc(${Number((100 - at).toFixed(4))}% + var(--cb-space-2))` };
    const more = extra?.(active);
    tooltip = (
      <div className="cb-trend-tip" data-part="trend-chart-tooltip" aria-hidden="true" style={side}>
        <div className="cb-trend-tip-x">
          {x[active]?.label}
          {active === current ? (
            <span className="cb-trend-tip-current">{t("trendChart.current")}</span>
          ) : null}
        </div>
        {panels.map((p) => (
          <div key={p.id} className="cb-trend-tip-row">
            <span className="cb-trend-tip-label">{p.label}</span>
            <span className="cb-trend-tip-value">{valueText(p, active)}</span>
          </div>
        ))}
        {more != null && more !== false ? <div className="cb-trend-tip-extra">{more}</div> : null}
      </div>
    );
    liveText = byKey ? (
      <>
        {xLabel(active)}
        {panels.map((p) => ` · ${p.label} ${valueText(p, active)}`).join("")}
        {more != null && more !== false ? <> · {more}</> : null}
      </>
    ) : null;
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a chart is a group of images, not a fieldset of form controls
    <div
      className="cb-trend"
      role="group"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is one focusable group (←/→ move the point, spec §6.8)
      tabIndex={0}
      data-part="trend-chart"
      data-density={density}
      data-state={isEmpty ? "empty" : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        // focus from a pointer press is not keyboard focus: the press shows its own column
        if (pointerDown.current) return;
        setByKey(true);
        if (active === null && n > 0) show(last ?? current ?? n - 1);
      }}
      onPointerDown={() => {
        pointerDown.current = true;
      }}
      onPointerUp={() => {
        pointerDown.current = false;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(null);
      }}
      onPointerLeave={onPointerLeave}
    >
      {isEmpty && empty ? (
        <p className="cb-trend-empty" data-part="trend-chart-empty">
          {empty}
        </p>
      ) : null}
      <div className="cb-trend-panels">
        {panels.map((p) => {
          const vals = p.values.slice(0, n);
          const max = Math.max(0, ...vals.map((v) => v ?? 0));
          const y = (v: number) =>
            max > 0 ? Math.round(bottom - (Math.max(0, v) / max) * (bottom - TOP)) : bottom;
          const li = latestIndex(vals, current);
          const maxI = vals.indexOf(max);
          const summary =
            li === null
              ? fill(t("trendChart.noData"), { label: p.label })
              : max <= 0
                ? fill(t("trendChart.allZero"), { label: p.label })
                : fill(t("trendChart.summary"), {
                    label: p.label,
                    max: p.format(max),
                    maxX: x[maxI]?.label ?? "",
                    last: p.format(vals[li] as number),
                    lastX: x[li]?.label ?? "",
                  });
          const segs: { from: number; to: number }[] = [];
          for (let i = 0; i + 1 < vals.length; i++) {
            if (vals[i] != null && vals[i + 1] != null) segs.push({ from: i, to: i + 1 });
          }
          return (
            <div key={p.id} className="cb-trend-panel" data-part="trend-chart-panel">
              <div className="cb-trend-head" data-part="trend-chart-head">
                <span className="cb-trend-title" data-part="trend-chart-title">
                  {p.label}
                </span>
                <span className="cb-trend-latest" data-part="trend-chart-latest">
                  {li === null ? "—" : p.format(vals[li] as number)}
                </span>
              </div>
              <svg
                className="cb-trend-plot"
                data-part="trend-chart-plot"
                role="img"
                aria-label={summary}
                width="100%"
                height={h}
              >
                <line
                  className="cb-trend-baseline"
                  data-part="trend-chart-baseline"
                  x1="0"
                  x2="100%"
                  y1={bottom}
                  y2={bottom}
                  shapeRendering="crispEdges"
                />
                {max > 0 ? (
                  <text
                    className="cb-trend-max"
                    data-part="trend-chart-max"
                    x="0"
                    y="0"
                    dominantBaseline="hanging"
                  >
                    {p.format(max)}
                  </text>
                ) : null}
                {segs.map((s) => (
                  <line
                    key={s.from}
                    className="cb-trend-segment"
                    data-part="trend-chart-segment"
                    data-from={s.from}
                    data-kind={s.to === current ? "current" : "normal"}
                    x1={`${cx(s.from, n)}%`}
                    x2={`${cx(s.to, n)}%`}
                    y1={y(vals[s.from] as number)}
                    y2={y(vals[s.to] as number)}
                  />
                ))}
                {active !== null && active < n ? (
                  <line
                    className="cb-trend-crosshair"
                    data-part="trend-chart-crosshair"
                    x1={`${cx(active, n)}%`}
                    x2={`${cx(active, n)}%`}
                    y1="0"
                    y2={h}
                    shapeRendering="crispEdges"
                  />
                ) : null}
                {vals.map((v, i) =>
                  v == null ? null : (
                    <rect
                      // biome-ignore lint/suspicious/noArrayIndexKey: one marker per fixed x position
                      key={i}
                      className="cb-trend-point"
                      data-part="trend-chart-point"
                      data-index={i}
                      data-kind={i === current ? "current" : "normal"}
                      x={`${cx(i, n)}%`}
                      y={y(v) - MARK / 2}
                      width={MARK}
                      height={MARK}
                      transform={`translate(${-MARK / 2} 0)`}
                      shapeRendering="crispEdges"
                    />
                  ),
                )}
              </svg>
            </div>
          );
        })}
        <div className="cb-trend-hits" aria-hidden="true" style={columns}>
          {x.map((pos, i) => (
            <span
              key={pos.key}
              className="cb-trend-hit"
              data-part="trend-chart-hit"
              onPointerEnter={(e) => {
                if (e.pointerType === "touch") return;
                setByKey(false);
                show(i);
              }}
              onPointerDown={() => {
                setByKey(false);
                show(i);
              }}
            />
          ))}
        </div>
        {tooltip}
      </div>
      <div className="cb-trend-x" aria-hidden="true" style={columns}>
        {x.map((pos, i) => (
          <span key={pos.key} className="cb-trend-x-label" data-part="trend-chart-x">
            {(n - 1 - i) % step === 0 ? pos.label : ""}
          </span>
        ))}
      </div>
      <div className="cb-sr-only" aria-live="polite" data-part="trend-chart-live">
        {liveText}
      </div>
      <table className="cb-sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t("trendChart.x")}</th>
            {panels.map((p) => (
              <th key={p.id} scope="col">
                {p.label}
              </th>
            ))}
            {extra ? <th scope="col">{extraLabel ?? ""}</th> : null}
          </tr>
        </thead>
        <tbody>
          {x.map((pos, i) => (
            <tr key={pos.key}>
              <th scope="row">{xLabel(i)}</th>
              {panels.map((p) => (
                <td key={p.id}>{valueText(p, i)}</td>
              ))}
              {extra ? <td>{extra(i)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
