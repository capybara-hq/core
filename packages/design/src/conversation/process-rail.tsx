import {
  createContext,
  type FocusEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { fillCopy } from "./tool-copy";

// The process rail's list (conversation process blocks spec §1.3; #924, #925): the rows of an open
// block, windowed once there are many, and the section headers that cut the rail by task list
// item. Rows mount only near the viewport; spacers keep the rail's height and draw its rule, and
// every row carries its true place on the rail (`data-edge`), so the rule still starts at the
// first icon and ends at the last one whichever rows are mounted.

/** A row's place on the rail's rule: where the rule starts and ends. */
export type RailEdge = "first" | "mid" | "last" | "only";

type RowPlace = {
  key: string;
  edge: RailEdge;
  /** Reports the row's element, so the list measures its height. */
  measure(el: HTMLElement | null): void;
};

/** The place of the row being drawn, given by the {@link RailList} that draws it. */
const RailRowContext = createContext<RowPlace | null>(null);

/** The attributes and ref a rail row takes from its list (none when drawn by hand). */
export function useRailRow(): {
  "data-edge"?: RailEdge;
  "data-rail-key"?: string;
  ref?: (el: HTMLElement | null) => void;
} {
  const place = useContext(RailRowContext);
  if (place === null) return {};
  return { "data-edge": place.edge, "data-rail-key": place.key, ref: place.measure };
}

/** One row of the list: drawn only while it is mounted (a `RailStep` or a `RailSection`). */
export type RailRow = { key: string; render(): ReactNode };

/** Rows up to this many are all mounted; past it the list windows them. */
export const RAIL_VIRTUAL_MIN = 120;
/** A row's height before it is measured (a dense line and the gap under it). */
const ESTIMATE = 32;
/** Rows are mounted this far (px) above and below the viewport. */
const OVERSCAN = 800;
/** Rows mounted before the first measure (server render, first paint). */
const INITIAL = 60;

/** The element that scrolls the list, or null for the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll" || y === "overlay") return p;
  }
  return null;
}

const edgeOf = (i: number, n: number): RailEdge =>
  n === 1 ? "only" : i === 0 ? "first" : i === n - 1 ? "last" : "mid";

/**
 * The rail's rows. Up to {@link RAIL_VIRTUAL_MIN} all are mounted; past it only those near the
 * viewport (measured as they mount, estimated until then), the rest are spacers that keep the
 * rail's height. A focused row stays mounted while focus is in it, so the keyboard never loses its
 * place; the mounted rows are in rail order, so the reading order is the rail's.
 */
export function RailList({ rows }: { rows: readonly RailRow[] }): JSX.Element {
  const n = rows.length;
  const virtual = n > RAIL_VIRTUAL_MIN;
  const list = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const keyOf = useRef(new WeakMap<Element, string>());
  const observer = useRef<ResizeObserver | null>(null);
  const measures = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const [range, setRange] = useState<readonly [number, number]>([0, Math.min(n, INITIAL)]);
  const [focused, setFocused] = useState<string | null>(null);
  const [, remeasured] = useReducer((x: number) => x + 1, 0);

  // each row's top, from the measured heights (the measured average for the rest)
  let sum = 0;
  let count = 0;
  for (const h of heights.current.values()) {
    sum += h;
    count++;
  }
  const estimate = count > 0 ? sum / count : ESTIMATE;
  const tops = new Array<number>(n + 1);
  tops[0] = 0;
  for (let i = 0; i < n; i++) {
    const key = rows[i]?.key ?? "";
    tops[i + 1] = (tops[i] ?? 0) + (heights.current.get(key) ?? estimate);
  }
  const topsRef = useRef(tops);
  topsRef.current = tops;

  const update = useCallback(() => {
    const el = list.current;
    if (el === null) return;
    const t = topsRef.current;
    const total = t.length - 1;
    const box = el.getBoundingClientRect();
    const sp = scrollParent(el);
    const view = sp === null ? { top: 0, bottom: window.innerHeight } : sp.getBoundingClientRect();
    const from = view.top - box.top - OVERSCAN;
    const to = view.bottom - box.top + OVERSCAN;
    let start = 0;
    while (start < total && (t[start + 1] ?? 0) <= from) start++;
    let end = start;
    while (end < total && (t[end] ?? 0) < to) end++;
    setRange((r) => (r[0] === start && r[1] === end ? r : [start, end]));
  }, []);

  // the window follows scrolling and resizing (once per frame)
  useEffect(() => {
    if (!virtual) return;
    const el = list.current;
    if (el === null) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const target: HTMLElement | Window = scrollParent(el) ?? window;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [virtual, update]);

  // rows are measured as they mount and whenever they change size (a step opened in place)
  useEffect(() => {
    if (!virtual || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = keyOf.current.get(entry.target);
        if (key === undefined) continue;
        const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (h > 0 && heights.current.get(key) !== h) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed) remeasured();
    });
    observer.current = ro;
    for (const el of list.current?.querySelectorAll("[data-rail-key]") ?? []) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, [virtual]);

  // after every render: the window for the current heights and scroll position (settles at once)
  useLayoutEffect(() => {
    if (virtual) update();
  });

  const measureOf = (key: string) => {
    let m = measures.current.get(key);
    if (m === undefined) {
      m = (el: HTMLElement | null) => {
        if (el === null) return;
        keyOf.current.set(el, key);
        observer.current?.observe(el);
      };
      measures.current.set(key, m);
    }
    return m;
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const row = (e.target as Element).closest("[data-rail-key]");
    const key = row?.getAttribute("data-rail-key") ?? null;
    if (key !== focused) setFocused(key);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next === null || !e.currentTarget.contains(next)) setFocused(null);
  };

  // the rows to mount: the window, and the focused row wherever it is
  let shown: number[];
  if (!virtual) shown = rows.map((_, i) => i);
  else {
    const [a, b] = [Math.min(range[0], n), Math.min(range[1], n)];
    shown = [];
    for (let i = a; i < b; i++) shown.push(i);
    const f = focused === null ? -1 : rows.findIndex((r) => r.key === focused);
    if (f >= 0 && (f < a || f >= b)) {
      shown.push(f);
      shown.sort((x, y) => x - y);
    }
  }

  const out: ReactNode[] = [];
  let next = 0;
  for (const i of shown) {
    if (i > next)
      out.push(<Spacer key={`gap:${next}`} height={(tops[i] ?? 0) - (tops[next] ?? 0)} />);
    const row = rows[i];
    if (row !== undefined) {
      out.push(
        <RailRowContext.Provider
          key={row.key}
          value={{ key: row.key, edge: edgeOf(i, n), measure: virtual ? measureOf(row.key) : noop }}
        >
          {row.render()}
        </RailRowContext.Provider>,
      );
    }
    next = i + 1;
  }
  if (next < n)
    out.push(<Spacer key={`gap:${next}`} height={(tops[n] ?? 0) - (tops[next] ?? 0)} />);

  return (
    <div
      ref={list}
      className="cb-rail-list"
      data-part="rail-list"
      {...(virtual ? { "data-virtual": "true", onFocus, onBlur } : {})}
    >
      {out}
    </div>
  );
}

const noop = () => {};

/** Rows not mounted: their height, with the rail's rule running through. */
function Spacer({ height }: { height: number }): JSX.Element {
  return (
    <div className="cb-rail-spacer" data-part="rail-spacer" aria-hidden="true" style={{ height }} />
  );
}

export type RailSectionProps = {
  /** The task list item the section's steps ran under. */
  title: string;
  /** The run's latest list has the item done. */
  done: boolean;
  /** The steps in the section. */
  steps: number;
  open: boolean;
  onToggle(): void;
};

/**
 * A section header on the rail (#924): the task list item that was current while the steps under
 * it ran, a check once it is done, the step count, and a toggle that folds the section's steps.
 */
export function RailSection({ title, done, steps, open, onToggle }: RailSectionProps): JSX.Element {
  const t = useDesignT();
  const row = useRailRow();
  return (
    <div
      className="cb-rail-step cb-rail-section"
      data-part="rail-section"
      data-done={done}
      {...row}
    >
      <span className="cb-rail-gutter" data-part="rail-gutter" aria-hidden="true">
        <span>
          <Icon name={done ? "check" : "list-checks"} size={14} />
        </span>
      </span>
      <div className="cb-rail-body">
        <button
          type="button"
          className="cb-rail-section-head"
          data-part="rail-section-head"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="cb-rail-section-title">{title}</span>
          <span className="cb-rail-section-count cb-faint">
            {steps === 1
              ? t("process.sectionSteps1")
              : fillCopy(t("process.sectionSteps"), { n: steps })}
          </span>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </button>
      </div>
    </div>
  );
}
