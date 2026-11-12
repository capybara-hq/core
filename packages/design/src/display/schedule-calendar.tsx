import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem, Popover } from "../overlays/menus";
import { useDesignT } from "../provider";
import { SIZES } from "../tokens";
import { EmptyState } from "./empty-state";
import { SkeletonBox, SkeletonGroup, SkeletonText } from "./skeleton";
import { Segmented } from "./tabs";

/** A run's state on the calendar (spec §6.40, scheduled tasks calendar design §6.2). */
export type ScheduleCalendarState = "upcoming" | "running" | "completed" | "failed" | "skipped";

/** One run or planned occurrence, already placed in the viewer's zone by the page. */
export type ScheduleCalendarItem = {
  id: string;
  /** YYYY-MM-DD, viewer-local. */
  day: string;
  /** Minutes after the viewer-local midnight, 0..1439. */
  minute: number;
  /** The time drawn in the block (「09:00」). */
  time: string;
  /** The task name. */
  title: string;
  /** The agent's name (and the creator's in the org-wide view), where there is room. */
  meta?: string;
  state: ScheduleCalendarState;
  /** A mark after the name (试运行 / 手动). */
  mark?: string;
  /** The full accessible name (「每日简报，研究助手，11月12日 周四 09:00，已完成」). */
  label: string;
};

/** A dense task's day, one chip instead of its blocks (scheduled tasks calendar design §5.4). */
export type ScheduleCalendarCollapsed = {
  id: string;
  day: string;
  /** The task name. */
  title: string;
  /** 「每小时 · 24 次」. */
  summary: string;
  /** The failures of the day (「2 次失败」), drawn in `fail` with `circle-x`. */
  failed?: string;
  state: ScheduleCalendarState;
  label: string;
};

export type ScheduleCalendarProps = {
  /** `agenda` forces the phone's day list at every width; below 640 CSS shows it anyway. */
  range: "week" | "month" | "agenda";
  /** The viewer-local days shown (YYYY-MM-DD): 7 for a week, 42 (6 × 7, Monday first) for a month. */
  days: string[];
  today: string;
  /** Epoch ms (the page's `useNow`): the now line. */
  now: number;
  /** The viewer's zone, used only to place the now line. */
  timeZone: string;
  items: ScheduleCalendarItem[];
  collapsed: ScheduleCalendarCollapsed[];
  selectedId?: string;
  onSelect(id: string): void;
  onNavigate(to: "prev" | "next" | "today"): void;
  onRange(range: "week" | "month"): void;
  /** 「2026-11-09 – 11-15」 / 「2026-11」: the toolbar's label, the grid's name and the live text. */
  rangeLabel: string;
  /** Org admins only: 只看我的 / 全组织. */
  scope?: {
    value: "mine" | "all";
    onChange(value: "mine" | "all"): void;
    labels: { mine: string; all: string };
  };
  /** The zone and horizon line under the grid. */
  footnote?: string;
  /** Nothing to show yet: the grid frame with skeleton blocks. */
  loading?: boolean;
  /** A range change in flight while the previous range stays drawn: a spinner by the label. */
  refreshing?: boolean;
  /** Nothing in the range: a panel EmptyState over the grid body. */
  empty?: { text: string; hint?: string; action?: { label: string; onSelect(): void } };
  /** The range failed to load: the load-failed line with 重试, the grid kept. */
  error?: { retry(): void; code?: string };
  /** Days at or after it are drawn as not loaded (the kernel cut the range, design §5.5). */
  notLoadedFrom?: string;
  /** A day was picked: a month day number (go to its week) or an agenda day button. */
  onDay?(day: string): void;
  /** The agenda's day (the page's `date=`); default today when shown, else the first day. */
  day?: string;
};

const STATE_ICON: Record<ScheduleCalendarState, IconName> = {
  upcoming: "clock",
  running: "spinner",
  completed: "check",
  failed: "circle-x",
  skipped: "ban",
};

/** One block is half an hour high; blocks whose half hours overlap share the column. */
const SLOT = 30;
/**
 * At most two side by side (three in a 154 px day column left about 51 px each: an icon and a
 * clipped time); with more, the second place is 「+N」.
 */
const MAX_LANES = 2;
/** The month cell lists three lines; with more, the third is 「+N 项」. */
const MONTH_LINES = 3;
/** Scroll to 07:00, or an hour before the earliest item when that is earlier. */
const SCROLL_HOUR = 7;
const HOUR_PX = SIZES.layout["calendar-hour"];

function fill(template: string, args: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(args[k] ?? ""));
}

function parseDay(day: string): { y: number; m: number; d: number; wd: number } {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  // Monday 0 … Sunday 6; the date is plain data (no clock, no zone)
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return { y, m, d, wd };
}

/** The viewer-local minute of `now` in `timeZone`, or null for a zone Intl does not know. */
function minuteIn(now: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch {
    return null;
  }
}

const top = (minute: number): string => `calc(var(--cb-layout-calendar-hour) * ${minute / 60})`;

type Placed =
  | { kind: "item"; item: ScheduleCalendarItem; lane: number; lanes: number }
  | { kind: "more"; items: ScheduleCalendarItem[]; minute: number; lane: number; lanes: number };

/**
 * A day's blocks side by side: clusters of overlapping half hours, lanes assigned in time order;
 * a cluster that needs more than two lanes keeps the first and puts the rest in 「+N」 (the
 * second).
 */
function placeDay(items: ScheduleCalendarItem[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id));
  const out: Placed[] = [];
  let cluster: ScheduleCalendarItem[] = [];
  let end = -1;
  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnd: number[] = [];
    const lane = new Map<string, number>();
    for (const it of cluster) {
      let l = laneEnd.findIndex((e) => e <= it.minute);
      if (l < 0) {
        l = laneEnd.length;
        laneEnd.push(0);
      }
      laneEnd[l] = it.minute + SLOT;
      lane.set(it.id, l);
    }
    const lanes = laneEnd.length;
    if (lanes <= MAX_LANES) {
      for (const it of cluster)
        out.push({ kind: "item", item: it, lane: lane.get(it.id) ?? 0, lanes });
    } else {
      const rest: ScheduleCalendarItem[] = [];
      for (const it of cluster) {
        const l = lane.get(it.id) ?? 0;
        if (l < MAX_LANES - 1) out.push({ kind: "item", item: it, lane: l, lanes: MAX_LANES });
        else rest.push(it);
      }
      const first = rest[0]?.minute ?? 0;
      out.push({ kind: "more", items: rest, minute: first, lane: MAX_LANES - 1, lanes: MAX_LANES });
    }
    cluster = [];
    end = -1;
  };
  for (const it of sorted) {
    if (cluster.length > 0 && it.minute >= end) flush();
    cluster.push(it);
    end = Math.max(end, it.minute + SLOT);
  }
  flush();
  return out.sort((a, b) => minuteOf(a) - minuteOf(b) || a.lane - b.lane);
}

const minuteOf = (p: Placed) => (p.kind === "item" ? p.item.minute : p.minute);

/** One stop of the grid's roving focus. */
type Stop = { key: string; dayIndex: number; minute: number };

function StateIcon({ state }: { state: ScheduleCalendarState }) {
  return (
    <span className="cb-scal-icon" data-part="schedule-calendar-icon" data-state={state}>
      <Icon name={STATE_ICON[state]} size={12} />
    </span>
  );
}

/**
 * The calendar of scheduled task runs (spec §6.40; scheduled tasks calendar design §4, §6, §7):
 * a week time grid (Monday first, 00–24, the now line, blocks of half an hour, two side by side
 * then 「+N」, the dense lane), a 6 × 7 month grid (three lines then 「+N 项」) and the phone's
 * agenda (seven day buttons over the day's rows). The grid and the agenda are both drawn and CSS
 * shows the agenda below 640 (`range="agenda"` forces it). Plain props: the page places every
 * item in the viewer's zone; the component reads no clock and no zone of its own.
 */
export function ScheduleCalendar(props: ScheduleCalendarProps) {
  const { range, days, rangeLabel, scope, footnote, refreshing, error, onNavigate, onRange } =
    props;
  const t = useDesignT();
  const month = range === "month";
  const view: "week" | "month" =
    month || (range === "agenda" && days.length > 7) ? "month" : "week";
  const [announce, setAnnounce] = useState("");
  const prevLabel = useRef(rangeLabel);
  useEffect(() => {
    if (rangeLabel !== prevLabel.current) setAnnounce(rangeLabel);
    prevLabel.current = rangeLabel;
  }, [rangeLabel]);

  const viewOptions = [
    { value: "week", label: t("scheduleCalendar.week") },
    { value: "month", label: t("scheduleCalendar.month") },
  ];
  const options: MenuItem[] = [
    ...viewOptions.map((o) => ({
      label: o.label,
      checked: view === o.value,
      onSelect: () => onRange(o.value as "week" | "month"),
    })),
    ...(scope
      ? [
          "separator" as const,
          ...(["mine", "all"] as const).map((v) => ({
            label: scope.labels[v],
            checked: scope.value === v,
            onSelect: () => scope.onChange(v),
          })),
        ]
      : []),
  ];

  return (
    <div className="cb-scal" data-part="schedule-calendar" data-range={range}>
      <div className="cb-scal-toolbar" data-part="schedule-calendar-toolbar">
        <Button onClick={() => onNavigate("today")}>{t("scheduleCalendar.today")}</Button>
        <IconButton
          label={t(
            view === "month" && range !== "agenda"
              ? "scheduleCalendar.prevMonth"
              : "scheduleCalendar.prevWeek",
          )}
          icon={<Icon name="chevron-left" />}
          onClick={() => onNavigate("prev")}
        />
        <IconButton
          label={t(
            view === "month" && range !== "agenda"
              ? "scheduleCalendar.nextMonth"
              : "scheduleCalendar.nextWeek",
          )}
          icon={<Icon name="chevron-right" />}
          onClick={() => onNavigate("next")}
        />
        <span className="cb-scal-range" data-part="schedule-calendar-range">
          {rangeLabel}
        </span>
        {refreshing ? (
          <span
            className="cb-scal-spin"
            data-part="schedule-calendar-refreshing"
            aria-hidden="true"
          >
            <Icon name="spinner" size={14} />
          </span>
        ) : null}
        <span className="cb-scal-tools-end">
          <span className="cb-scal-wide">
            <Segmented
              label={t("scheduleCalendar.view")}
              options={viewOptions}
              value={view}
              onChange={(v) => onRange(v as "week" | "month")}
            />
            {scope ? (
              <Segmented
                label={t("scheduleCalendar.scope")}
                options={[
                  { value: "mine", label: scope.labels.mine },
                  { value: "all", label: scope.labels.all },
                ]}
                value={scope.value}
                onChange={(v) => scope.onChange(v as "mine" | "all")}
              />
            ) : null}
          </span>
          <span className="cb-scal-narrow">
            <Menu
              label={t("scheduleCalendar.options")}
              items={options}
              trigger={
                <IconButton label={t("scheduleCalendar.options")} icon={<Icon name="sliders" />} />
              }
            />
          </span>
        </span>
      </div>
      <div className="cb-sr-only" aria-live="polite" data-part="schedule-calendar-live">
        {announce}
      </div>
      <div className="cb-scal-box" data-part="schedule-calendar-box">
        {error ? (
          <div className="cb-scal-error" data-part="schedule-calendar-error" role="alert">
            <span className="cb-scal-error-text" data-part="schedule-calendar-error-text">
              <Icon name="circle-x" size={14} />
              {t("scheduleCalendar.failed")}
            </span>
            {error.code ? <span className="cb-scal-error-code">{error.code}</span> : null}
            <Button density="dense" onClick={error.retry}>
              {t("scheduleCalendar.retry")}
            </Button>
          </div>
        ) : null}
        {range === "agenda" ? null : month ? <MonthGrid {...props} /> : <WeekGrid {...props} />}
        <Agenda {...props} />
      </div>
      {footnote ? (
        <p className="cb-scal-footnote" data-part="schedule-calendar-footnote">
          {footnote}
        </p>
      ) : null}
    </div>
  );
}

/** Weekday names and the full day label from the design i18n (never `toLocaleString`). */
function useDayWords() {
  const t = useDesignT();
  const weekdays = t("scheduleCalendar.weekdays").split(",");
  const narrow = t("scheduleCalendar.weekdaysNarrow").split(",");
  const months = t("scheduleCalendar.months").split(",");
  const label = (day: string) => {
    const p = parseDay(day);
    return fill(t("scheduleCalendar.dayLabel"), {
      m: p.m,
      d: p.d,
      w: weekdays[p.wd] ?? "",
      mon: months[p.m - 1] ?? "",
    });
  };
  return { weekdays, narrow, label };
}

/** Roving focus over the grid's stops (spec §6.40 keys), shared by the week and month grids. */
function useRoving(
  stops: Stop[],
  props: ScheduleCalendarProps,
  move: (from: Stop, key: string) => Stop | undefined,
) {
  const { days, today, selectedId, onNavigate } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // the weekday (or today) PageUp / PageDown / t asked for, and the range it was asked from
  const pending = useRef<{ want: number | "today"; from: string } | null>(null);
  const todayIndex = days.indexOf(today);
  const fallback =
    stops.find((s) => s.key === `i:${selectedId}` || s.key === `c:${selectedId}`)?.key ??
    stops.find((s) => s.dayIndex === todayIndex)?.key ??
    stops[0]?.key;
  const current = active !== null && stops.some((s) => s.key === active) ? active : fallback;

  const focusKey = (key: string) => {
    setActive(key);
    ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  // After PageUp / PageDown / t, focus lands on the same weekday (or today) of the new range. The
  // days change first and the items later (the page keeps the previous answer while it reads), so
  // the request waits until the new range has stops; meanwhile focus rests on the grid itself.
  const daysKey = days.join(",");
  const stopsKey = stops.map((s) => s.key).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the range or its stops change
  useEffect(() => {
    const p = pending.current;
    if (p === null || p.from === daysKey) return;
    const grid = ref.current;
    const at = document.activeElement;
    const ours = at === null || at === document.body || (grid?.contains(at) ?? false);
    if (!ours) {
      pending.current = null;
      return;
    }
    if (stops.length === 0) {
      if (at !== grid) grid?.focus();
      return;
    }
    pending.current = null;
    const target =
      p.want === "today"
        ? stops.find((s) => s.dayIndex === days.indexOf(today))
        : stops.find((s) => s.dayIndex % 7 === p.want);
    const key = target?.key ?? stops[0]?.key;
    if (key) focusKey(key);
  }, [daysKey, stopsKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    const from = stops.find((s) => s.key === el?.dataset.key);
    if (!from) return;
    let to: Stop | undefined;
    switch (e.key) {
      case "Home":
        to = stops[0];
        break;
      case "End":
        to = stops[stops.length - 1];
        break;
      case "PageUp":
      case "PageDown":
        e.preventDefault();
        pending.current = { want: from.dayIndex % 7, from: daysKey };
        onNavigate(e.key === "PageUp" ? "prev" : "next");
        return;
      case "t":
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        pending.current = { want: "today", from: daysKey };
        onNavigate("today");
        return;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        to = move(from, e.key);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (to) focusKey(to.key);
  };

  const stop = (key: string) => ({
    "data-key": key,
    tabIndex: key === current ? 0 : -1,
    onFocus: () => setActive(key),
  });
  return { ref, onKeyDown, stop };
}

function WeekGrid(props: ScheduleCalendarProps) {
  const { days, today, now, timeZone, items, collapsed, selectedId, onSelect, rangeLabel } = props;
  const { loading, empty, notLoadedFrom } = props;
  const t = useDesignT();
  const words = useDayWords();
  const loaded = (day: string) => notLoadedFrom === undefined || day < notLoadedFrom;
  const perDay = days.map((day) =>
    loaded(day) && !loading ? placeDay(items.filter((it) => it.day === day)) : [],
  );
  const chips = days.map((day) =>
    loaded(day) && !loading ? collapsed.filter((c) => c.day === day) : [],
  );
  const hasLane = chips.some((c) => c.length > 0);

  const stops: Stop[] = [];
  days.forEach((_, i) => {
    for (const c of chips[i] ?? []) stops.push({ key: `c:${c.id}`, dayIndex: i, minute: -1 });
    for (const p of perDay[i] ?? [])
      stops.push({
        key: p.kind === "item" ? `i:${p.item.id}` : `m:${days[i]}:${p.minute}`,
        dayIndex: i,
        minute: minuteOf(p),
      });
  });
  const roving = useRoving(stops, props, (from, key) => {
    const inDay = stops.filter((s) => s.dayIndex === from.dayIndex);
    const at = inDay.findIndex((s) => s.key === from.key);
    if (key === "ArrowUp") return inDay[at - 1];
    if (key === "ArrowDown") return inDay[at + 1];
    const step = key === "ArrowLeft" ? -1 : 1;
    for (let d = from.dayIndex + step; d >= 0 && d < days.length; d += step) {
      const there = stops.filter((s) => s.dayIndex === d);
      if (there.length === 0) continue;
      return there.reduce((best, s) =>
        Math.abs(s.minute - from.minute) < Math.abs(best.minute - from.minute) ? s : best,
      );
    }
    return undefined;
  });

  // open at 07:00, or an hour before the week's earliest item when that is earlier (instant)
  const scrollRef = useRef<HTMLDivElement>(null);
  const earliest = Math.min(...perDay.flat().map(minuteOf), SCROLL_HOUR * 60 + 60);
  const scrollTo = Math.max(0, Math.min(SCROLL_HOUR * 60, Math.floor(earliest / 60) * 60 - 60));
  const daysKey = days.join(",");
  // the person scrolled this range: later answers (loading ending, items arriving) keep their place
  const scrolled = useRef<{ days: string; byUser: boolean; set: number | null }>({
    days: daysKey,
    byUser: false,
    set: null,
  });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const s = scrolled.current;
    if (s.days !== daysKey) {
      s.days = daysKey;
      s.byUser = false;
    }
    if (s.byUser) return;
    const want = (scrollTo / 60) * HOUR_PX;
    s.set = want;
    if (el.scrollTop !== want) el.scrollTop = want;
  }, [daysKey, scrollTo]);
  // a scroll event at the position we set is ours; anywhere else the person moved the grid
  const onScroll = () => {
    const s = scrolled.current;
    const el = scrollRef.current;
    if (el && (s.set === null || Math.abs(el.scrollTop - s.set) > 1)) s.byUser = true;
  };

  const nowMinute = days.includes(today) ? minuteIn(now, timeZone) : null;
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

  const block = (p: Placed, day: string) => {
    const pos: CSSProperties = {
      top: top(minuteOf(p)),
      left: `${(p.lane * 100) / p.lanes}%`,
      width: `calc(${100 / p.lanes}% - 2px)`,
    };
    if (p.kind === "more") {
      const label = fill(t("scheduleCalendar.moreLabel"), {
        n: p.items.length,
        day: words.label(day),
      });
      return (
        <MorePopover
          key={`m:${p.minute}`}
          items={p.items}
          head={words.label(day)}
          onSelect={onSelect}
          selectedId={selectedId}
          trigger={
            <button
              type="button"
              className="cb-scal-more"
              data-part="schedule-calendar-more"
              aria-label={label}
              style={pos}
              {...roving.stop(`m:${day}:${p.minute}`)}
            >
              {fill(t("scheduleCalendar.more"), { n: p.items.length })}
            </button>
          }
        />
      );
    }
    const it = p.item;
    return (
      <button
        key={it.id}
        type="button"
        className="cb-scal-block"
        data-part="schedule-calendar-block"
        data-state={it.state}
        data-selected={it.id === selectedId ? "true" : undefined}
        aria-current={it.id === selectedId ? "true" : undefined}
        aria-label={it.label}
        title={it.label}
        style={pos}
        onClick={() => onSelect(it.id)}
        {...roving.stop(`i:${it.id}`)}
      >
        <ItemLine item={it} />
      </button>
    );
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a grid of day groups, not a fieldset of form controls
    <div
      className="cb-scal-grid"
      data-part="schedule-calendar-grid"
      data-view="week"
      role="group"
      aria-label={rangeLabel}
      aria-busy={loading ? true : undefined}
      ref={roving.ref}
      tabIndex={-1}
      onKeyDown={roving.onKeyDown}
    >
      <div
        className="cb-scal-scroll"
        data-part="schedule-calendar-scroll"
        ref={scrollRef}
        onScroll={onScroll}
      >
        <div className="cb-scal-pin">
          <div className="cb-scal-band" aria-hidden="true">
            <span className="cb-scal-corner" />
            {days.map((day) => {
              const p = parseDay(day);
              const isToday = day === today;
              return (
                <div
                  key={day}
                  className="cb-scal-dayhead"
                  data-part="schedule-calendar-day-head"
                  data-today={isToday ? "true" : undefined}
                >
                  <span className="cb-scal-weekday">{words.weekdays[p.wd]}</span>
                  <span
                    className="cb-scal-date"
                    data-part="schedule-calendar-date"
                    data-today={isToday ? "true" : undefined}
                  >
                    {day.slice(5)}
                  </span>
                  {loaded(day) ? null : (
                    <span className="cb-scal-not-loaded" data-part="schedule-calendar-not-loaded">
                      {t("scheduleCalendar.notLoaded")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {hasLane ? (
            <div className="cb-scal-band cb-scal-lane" data-part="schedule-calendar-lane">
              <span className="cb-scal-corner" />
              {days.map((day, i) => (
                <div key={day} className="cb-scal-lane-day">
                  {(chips[i] ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="cb-scal-chip"
                      data-part="schedule-calendar-chip"
                      data-state={c.state}
                      data-selected={c.id === selectedId ? "true" : undefined}
                      aria-current={c.id === selectedId ? "true" : undefined}
                      aria-label={c.label}
                      title={c.label}
                      onClick={() => onSelect(c.id)}
                      {...roving.stop(`c:${c.id}`)}
                    >
                      <ChipLine chip={c} />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <SkeletonGroup label={t("scheduleCalendar.loading")} active={Boolean(loading)}>
          <div className="cb-scal-band cb-scal-body" data-part="schedule-calendar-body">
            <div className="cb-scal-axis" data-part="schedule-calendar-axis" aria-hidden="true">
              {hours.map((h) => (
                <span key={h} className="cb-scal-hour" data-part="schedule-calendar-hour">
                  {h}
                </span>
              ))}
            </div>
            {days.map((day, i) => {
              const label = words.label(day);
              return (
                // biome-ignore lint/a11y/useSemanticElements: a day's runs, named by the day
                <div
                  key={day}
                  className="cb-scal-day"
                  data-part="schedule-calendar-day"
                  data-today={day === today ? "true" : undefined}
                  role="group"
                  aria-label={label}
                >
                  <h3 className="cb-sr-only">{label}</h3>
                  {loading ? <SkeletonBlocks index={i} /> : null}
                  {(perDay[i] ?? []).map((p) => block(p, day))}
                  {day === today && nowMinute !== null ? (
                    <span
                      className="cb-scal-now"
                      data-part="schedule-calendar-now"
                      aria-hidden="true"
                      style={{ top: top(nowMinute) }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </SkeletonGroup>
      </div>
      {empty && !loading ? <EmptyOver empty={empty} /> : null}
    </div>
  );
}

/** Skeleton blocks in a loading week: one or two per day, at fixed times. */
function SkeletonBlocks({ index }: { index: number }) {
  const at = [
    [9 * 60, 14 * 60],
    [9 * 60],
    [9 * 60, 14 * 60],
    [10 * 60],
    [9 * 60, 17 * 60],
    [],
    [10 * 60],
  ][index % 7] as number[];
  return (
    <>
      {at.map((m) => (
        <span key={m} className="cb-scal-skeleton" style={{ top: top(m) }}>
          <SkeletonBox part="block" />
        </span>
      ))}
    </>
  );
}

function EmptyOver({
  empty,
  inline,
}: {
  empty: NonNullable<ScheduleCalendarProps["empty"]>;
  /** In the agenda's list instead of over the grid body. */
  inline?: boolean;
}) {
  return (
    <div
      className="cb-scal-empty"
      data-part="schedule-calendar-empty"
      data-inline={inline ? "true" : undefined}
    >
      <div className="cb-scal-empty-panel">
        <EmptyState
          size="panel"
          text={empty.text}
          {...(empty.hint ? { hint: empty.hint } : {})}
          {...(empty.action
            ? {
                action: {
                  label: empty.action.label,
                  variant: "default" as const,
                  onSelect: empty.action.onSelect,
                },
              }
            : {})}
        />
      </div>
    </div>
  );
}

function ItemLine({ item }: { item: ScheduleCalendarItem }) {
  return (
    <>
      <StateIcon state={item.state} />
      <span className="cb-scal-time" data-part="schedule-calendar-time">
        {item.time}
      </span>
      <span className="cb-scal-title" data-part="schedule-calendar-title">
        {item.title}
      </span>
      {item.mark ? <span className="cb-scal-mark">{item.mark}</span> : null}
    </>
  );
}

function ChipLine({ chip }: { chip: ScheduleCalendarCollapsed }) {
  return (
    <>
      <StateIcon state={chip.state} />
      {/* the name keeps up to half the line; the summary gives way first, with an ellipsis */}
      <span className="cb-scal-title cb-scal-chip-title" data-part="schedule-calendar-title">
        {chip.title}
      </span>
      <span className="cb-scal-tail" data-part="schedule-calendar-tail">
        <span className="cb-scal-summary" data-part="schedule-calendar-summary">
          {chip.summary}
        </span>
        {chip.failed ? (
          <span className="cb-scal-chip-failed" data-part="schedule-calendar-chip-failed">
            {" "}
            · {chip.failed}
          </span>
        ) : null}
      </span>
    </>
  );
}

/** The 「+N」 / 「+N 项」 Popover: the hidden items as buttons (design §4.3, §4.4). */
function MorePopover({
  trigger,
  head,
  items,
  collapsed = [],
  onSelect,
  selectedId,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  head: string;
  items: ScheduleCalendarItem[];
  collapsed?: ScheduleCalendarCollapsed[];
  onSelect(id: string): void;
  selectedId?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  // a choice closes the list first, then opens the run (focus returns to the trigger)
  const choose = (id: string) => {
    setOpen(false);
    onSelect(id);
  };
  return (
    <Popover trigger={trigger} open={open} onOpenChange={setOpen}>
      {/* biome-ignore lint/a11y/useSemanticElements: a list of buttons named by the day */}
      <div
        className="cb-scal-pop"
        data-part="schedule-calendar-popover"
        role="group"
        aria-label={head}
      >
        <p className="cb-scal-pop-head">{head}</p>
        {collapsed.map((c) => (
          <button
            key={c.id}
            type="button"
            className="cb-scal-pop-item"
            data-part="schedule-calendar-pop-item"
            data-state={c.state}
            data-selected={c.id === selectedId ? "true" : undefined}
            aria-current={c.id === selectedId ? "true" : undefined}
            aria-label={c.label}
            onClick={() => choose(c.id)}
          >
            <ChipLine chip={c} />
          </button>
        ))}
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className="cb-scal-pop-item"
            data-part="schedule-calendar-pop-item"
            data-state={it.state}
            data-selected={it.id === selectedId ? "true" : undefined}
            aria-current={it.id === selectedId ? "true" : undefined}
            aria-label={it.label}
            onClick={() => choose(it.id)}
          >
            <ItemLine item={it} />
          </button>
        ))}
      </div>
    </Popover>
  );
}

type MonthLine =
  | { kind: "chip"; chip: ScheduleCalendarCollapsed }
  | { kind: "item"; item: ScheduleCalendarItem };

function MonthGrid(props: ScheduleCalendarProps) {
  const { days, today, items, collapsed, selectedId, onSelect, onDay, rangeLabel } = props;
  const { loading, empty, notLoadedFrom } = props;
  const t = useDesignT();
  const words = useDayWords();
  const loaded = (day: string) => notLoadedFrom === undefined || day < notLoadedFrom;
  // the month the grid is about: its middle day is always inside it (6 × 7 from the Monday before the 1st)
  const shown = days[Math.floor(days.length / 2)]?.slice(0, 7) ?? "";
  const lines: MonthLine[][] = days.map((day) =>
    loaded(day) && !loading
      ? [
          ...collapsed
            .filter((c) => c.day === day)
            .map((chip) => ({ kind: "chip" as const, chip })),
          ...items
            .filter((it) => it.day === day)
            .sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id))
            .map((item) => ({ kind: "item" as const, item })),
        ]
      : [],
  );

  const stops: Stop[] = [];
  days.forEach((day, i) => {
    if (onDay) stops.push({ key: `d:${day}`, dayIndex: i, minute: -2 });
    const all = lines[i] ?? [];
    const visible = all.length > MONTH_LINES ? all.slice(0, MONTH_LINES - 1) : all;
    for (const l of visible)
      stops.push({
        key: l.kind === "chip" ? `c:${l.chip.id}` : `i:${l.item.id}`,
        dayIndex: i,
        minute: l.kind === "chip" ? -1 : l.item.minute,
      });
    if (all.length > MONTH_LINES) stops.push({ key: `m:${day}`, dayIndex: i, minute: 1440 });
  });
  const roving = useRoving(stops, props, (from, key) => {
    const at = stops.findIndex((s) => s.key === from.key);
    if (key === "ArrowLeft") return stops[at - 1];
    if (key === "ArrowRight") return stops[at + 1];
    // ↑ / ↓: the same place in the week above / below (a day further when that one is empty)
    const inDay = stops.filter((s) => s.dayIndex === from.dayIndex);
    const pos = inDay.findIndex((s) => s.key === from.key);
    const step = key === "ArrowUp" ? -7 : 7;
    for (let d = from.dayIndex + step; d >= 0 && d < days.length; d += step) {
      const there = stops.filter((s) => s.dayIndex === d);
      if (there.length > 0) return there[Math.min(pos, there.length - 1)];
    }
    return undefined;
  });

  return (
    // biome-ignore lint/a11y/useSemanticElements: a grid of day groups, not a fieldset of form controls
    <div
      className="cb-scal-grid"
      data-part="schedule-calendar-grid"
      data-view="month"
      role="group"
      aria-label={rangeLabel}
      aria-busy={loading ? true : undefined}
      ref={roving.ref}
      tabIndex={-1}
      onKeyDown={roving.onKeyDown}
    >
      <div className="cb-scal-month-head" aria-hidden="true">
        {words.weekdays.map((w) => (
          <span key={w} className="cb-scal-weekday" data-part="schedule-calendar-weekday">
            {w}
          </span>
        ))}
      </div>
      <SkeletonGroup label={t("scheduleCalendar.loading")} active={Boolean(loading)}>
        <div className="cb-scal-month" data-part="schedule-calendar-month">
          {days.map((day, i) => {
            const p = parseDay(day);
            const label = words.label(day);
            const all = lines[i] ?? [];
            const over = all.length > MONTH_LINES;
            const visible = over ? all.slice(0, MONTH_LINES - 1) : all;
            const rest = over ? all.slice(MONTH_LINES - 1) : [];
            const isToday = day === today;
            const number = (
              <span
                className="cb-scal-number"
                data-part="schedule-calendar-number"
                data-today={isToday ? "true" : undefined}
              >
                {p.d}
              </span>
            );
            return (
              // biome-ignore lint/a11y/useSemanticElements: a day's runs, named by the day
              <div
                key={day}
                className="cb-scal-cell"
                data-part="schedule-calendar-cell"
                data-outside={day.slice(0, 7) === shown ? undefined : "true"}
                data-today={isToday ? "true" : undefined}
                role="group"
                aria-label={label}
              >
                <h3 className="cb-sr-only">{label}</h3>
                <div className="cb-scal-cell-head">
                  {onDay ? (
                    <button
                      type="button"
                      className="cb-scal-daynum"
                      data-part="schedule-calendar-day-number"
                      aria-label={fill(t("scheduleCalendar.openDay"), { day: label })}
                      onClick={() => onDay(day)}
                      {...roving.stop(`d:${day}`)}
                    >
                      {number}
                    </button>
                  ) : (
                    <span className="cb-scal-daynum" data-part="schedule-calendar-day-number">
                      {number}
                    </span>
                  )}
                  {loaded(day) ? null : (
                    <span className="cb-scal-not-loaded" data-part="schedule-calendar-not-loaded">
                      {t("scheduleCalendar.notLoaded")}
                    </span>
                  )}
                </div>
                {loading && i % 3 === 0 ? (
                  <span className="cb-scal-cell-skeleton">
                    <SkeletonText width="70%" size="small" />
                  </span>
                ) : null}
                {visible.map((l) => {
                  const id = l.kind === "chip" ? l.chip.id : l.item.id;
                  const state = l.kind === "chip" ? l.chip.state : l.item.state;
                  const lineLabel = l.kind === "chip" ? l.chip.label : l.item.label;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="cb-scal-line"
                      data-part="schedule-calendar-line"
                      data-state={state}
                      data-selected={id === selectedId ? "true" : undefined}
                      aria-current={id === selectedId ? "true" : undefined}
                      aria-label={lineLabel}
                      title={lineLabel}
                      onClick={() => onSelect(id)}
                      {...roving.stop(`${l.kind === "chip" ? "c" : "i"}:${id}`)}
                    >
                      {l.kind === "chip" ? <ChipLine chip={l.chip} /> : <ItemLine item={l.item} />}
                    </button>
                  );
                })}
                {over ? (
                  <MorePopover
                    head={label}
                    items={all.flatMap((l) => (l.kind === "item" ? [l.item] : []))}
                    collapsed={all.flatMap((l) => (l.kind === "chip" ? [l.chip] : []))}
                    onSelect={onSelect}
                    selectedId={selectedId}
                    trigger={
                      <button
                        type="button"
                        className="cb-scal-line cb-scal-more-line"
                        data-part="schedule-calendar-more"
                        aria-label={fill(t("scheduleCalendar.moreLabel"), {
                          n: rest.length,
                          day: label,
                        })}
                        {...roving.stop(`m:${day}`)}
                      >
                        {fill(t("scheduleCalendar.moreItems"), { n: rest.length })}
                      </button>
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </SkeletonGroup>
      {empty && !loading ? <EmptyOver empty={empty} /> : null}
    </div>
  );
}

/** The phone's day list (design §7): seven day buttons over the chosen day's rows. */
function Agenda(props: ScheduleCalendarProps) {
  const { days, today, items, collapsed, selectedId, onSelect, onDay, loading, empty } = props;
  const { notLoadedFrom } = props;
  const t = useDesignT();
  const words = useDayWords();
  const loaded = (day: string) => notLoadedFrom === undefined || day < notLoadedFrom;
  const chosen =
    props.day && days.includes(props.day)
      ? props.day
      : days.includes(today)
        ? today
        : (days[0] ?? "");
  // a month's agenda pages by week: the seven days around the chosen one
  const start = Math.floor(Math.max(0, days.indexOf(chosen)) / 7) * 7;
  const week = days.slice(start, start + 7);
  const failedOn = (day: string) =>
    loaded(day) &&
    (items.some((it) => it.day === day && it.state === "failed") ||
      collapsed.some((c) => c.day === day && (c.state === "failed" || c.failed)));
  const chips = loaded(chosen) ? collapsed.filter((c) => c.day === chosen) : [];
  const rows = loaded(chosen)
    ? items
        .filter((it) => it.day === chosen)
        .sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id))
    : [];
  const chosenLabel = words.label(chosen);

  let body: ReactNode;
  if (loading) {
    body = (
      <SkeletonGroup label={t("scheduleCalendar.loading")}>
        {[0, 1, 2].map((i) => (
          <span key={i} className="cb-scal-row cb-scal-row-skeleton">
            <SkeletonText width={i === 1 ? "55%" : "70%"} />
          </span>
        ))}
      </SkeletonGroup>
    );
  } else if (empty) {
    body = <EmptyOver empty={empty} inline />;
  } else if (chips.length === 0 && rows.length === 0) {
    body = (
      <p className="cb-scal-day-empty" data-part="schedule-calendar-day-empty">
        {t(loaded(chosen) ? "scheduleCalendar.dayEmpty" : "scheduleCalendar.notLoaded")}
      </p>
    );
  } else {
    body = (
      <>
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            className="cb-scal-row"
            data-part="schedule-calendar-row"
            data-state={c.state}
            data-selected={c.id === selectedId ? "true" : undefined}
            aria-current={c.id === selectedId ? "true" : undefined}
            aria-label={c.label}
            onClick={() => onSelect(c.id)}
          >
            <ChipLine chip={c} />
          </button>
        ))}
        {rows.map((it) => (
          <button
            key={it.id}
            type="button"
            className="cb-scal-row"
            data-part="schedule-calendar-row"
            data-state={it.state}
            data-selected={it.id === selectedId ? "true" : undefined}
            aria-current={it.id === selectedId ? "true" : undefined}
            aria-label={it.label}
            onClick={() => onSelect(it.id)}
          >
            <ItemLine item={it} />
            {it.meta ? (
              <span className="cb-scal-meta" data-part="schedule-calendar-meta">
                {it.meta}
              </span>
            ) : null}
          </button>
        ))}
      </>
    );
  }

  return (
    <div className="cb-scal-agenda" data-part="schedule-calendar-agenda">
      {/* biome-ignore lint/a11y/useSemanticElements: a row of day buttons */}
      <div className="cb-scal-agenda-days" role="group" aria-label={t("scheduleCalendar.days")}>
        {week.map((day) => {
          const p = parseDay(day);
          const label = words.label(day);
          const failed = failedOn(day);
          return (
            <button
              key={day}
              type="button"
              className="cb-scal-agenda-day"
              data-part="schedule-calendar-agenda-day"
              data-today={day === today ? "true" : undefined}
              aria-pressed={day === chosen}
              aria-current={day === today ? "date" : undefined}
              aria-label={failed ? fill(t("scheduleCalendar.dayFailed"), { day: label }) : label}
              onClick={() => onDay?.(day)}
            >
              <span className="cb-scal-agenda-wd">{words.narrow[p.wd]}</span>
              <span className="cb-scal-agenda-num">{p.d}</span>
              {failed ? (
                <span
                  className="cb-scal-dot"
                  data-part="schedule-calendar-dot"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the chosen day's runs, named by the day */}
      <div
        className="cb-scal-agenda-list"
        data-part="schedule-calendar-agenda-list"
        role="group"
        aria-label={chosenLabel}
        aria-busy={loading ? true : undefined}
      >
        {body}
      </div>
    </div>
  );
}
