import { useNow, useTimeZone } from "../clock";
import { type Locale, messages } from "../i18n";
import { useDesignLocale } from "../provider";

const pad = (n: number) => String(n).padStart(2, "0");

/** One formatter per time zone (building an `Intl.DateTimeFormat` is the expensive part). */
const zoned = new Map<string, Intl.DateTimeFormat>();

/** The calendar fields of `d` in `timeZone` (the process's zone when undefined). */
function fieldsOf(d: Date, timeZone: string | undefined) {
  if (timeZone === undefined) {
    return {
      y: d.getFullYear(),
      mo: d.getMonth() + 1,
      d: d.getDate(),
      h: d.getHours(),
      mi: d.getMinutes(),
    };
  }
  let f = zoned.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    zoned.set(timeZone, f);
  }
  const part = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(part.year),
    mo: Number(part.month),
    d: Number(part.day),
    h: Number(part.hour) % 24,
    mi: Number(part.minute),
  };
}

/**
 * The one date format (spec §2.2, local time): `full` `YYYY-MM-DD HH:mm` in tables, meta and
 * detail fields; `compact` `MM-DD HH:mm` in dense lists (the sidebar's conversation rows). In a
 * component, pass `useTimeZone()` as `timeZone`, so a server-rendered date hydrates in the
 * server's zone before it switches to the browser's (without it: the process's zone).
 */
export function formatDateTime(
  iso: string | Date,
  form: "full" | "compact" = "full",
  timeZone?: string,
): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const f = fieldsOf(d, timeZone);
  const md = `${pad(f.mo)}-${pad(f.d)} ${pad(f.h)}:${pad(f.mi)}`;
  return form === "compact" ? md : `${f.y}-${md}`;
}

/** Calendar days between `d`'s and `now`'s dates in `timeZone` (0: the same day, 1: yesterday). */
export function daysAgo(d: Date, now: number, timeZone?: string): number {
  const a = fieldsOf(d, timeZone);
  const b = fieldsOf(new Date(now), timeZone);
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86_400_000);
}

/** Where a time falls for a list sectioned by time: today, yesterday, the 5 days before, older. */
export type DayBucket = "today" | "yesterday" | "week" | "older";

export function dayBucket(iso: string | Date, now: number, timeZone?: string): DayBucket {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const days = daysAgo(d, now, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return days < 7 ? "week" : "older";
}

/**
 * The time of a list row sectioned by day (the conversation lists, design spec §6.60): `HH:mm`
 * today, Yesterday, the weekday within the last week, else `MM-DD` (`YYYY-MM-DD` in another
 * year). `now` and `timeZone` come from `useNow()` / `useTimeZone()`, as for `formatRelative`.
 */
export function formatListTime(
  iso: string | Date,
  locale: Locale,
  now: number,
  timeZone?: string,
): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const f = fieldsOf(d, timeZone);
  const bucket = dayBucket(d, now, timeZone);
  if (bucket === "today") return `${pad(f.h)}:${pad(f.mi)}`;
  if (bucket === "yesterday") return messages[locale]["time.yesterday"];
  if (bucket === "week") {
    // the weekday of the zoned calendar date (noon UTC keeps it on that date in any zone)
    const day = new Date(Date.UTC(f.y, f.mo - 1, f.d, 12));
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      weekday: "short",
      timeZone: "UTC",
    }).format(day);
  }
  const year = fieldsOf(new Date(now), timeZone).y;
  return f.y === year ? `${pad(f.mo)}-${pad(f.d)}` : `${f.y}-${pad(f.mo)}-${pad(f.d)}`;
}

/**
 * A relative age ("5 分钟前", "yesterday"): the activity form and a date's tooltip. `now` is
 * required: in a component it is `useNow()`, so a server-rendered age hydrates with the server's
 * time instead of crossing a minute between the server render and the hydration.
 */
export function formatRelative(iso: string | Date, locale: string, now: number): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const s = Math.round((now - t) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86400), "day");
}

/**
 * A point in time (spec §2.2): `YYYY-MM-DD HH:mm` in mono with tabular figures, the relative age
 * as its tooltip. The text depends on the viewer's time zone and the age on the clock: both come
 * from `useTimeZone()` / `useNow()`, so the hydration repeats the server's render and the
 * browser's zone and clock take over right after it.
 */
export function DateTime({
  value,
  form = "full",
}: {
  value: string | Date;
  form?: "full" | "compact";
}) {
  const locale = useDesignLocale();
  const now = useNow();
  const timeZone = useTimeZone();
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return <span className="cb-datetime">—</span>;
  return (
    <time
      className="cb-datetime"
      dateTime={typeof value === "string" ? value : value.toISOString()}
      title={formatRelative(d, locale, now)}
    >
      {formatDateTime(d, form, timeZone)}
    </time>
  );
}

/** A version as the UI writes it (spec §2.2): mono, always one leading `v` ("v0.1.0-rc.0"). */
export function versionLabel(version: string | number): string {
  const v = String(version);
  return /^v\d/i.test(v) ? `v${v.slice(1)}` : `v${v}`;
}
