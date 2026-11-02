import { useDesignLocale } from "../provider";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The one date format (spec §2.2, local time): `full` `YYYY-MM-DD HH:mm` in tables, meta and
 * detail fields; `compact` `MM-DD HH:mm` in dense lists (the sidebar's conversation rows).
 */
export function formatDateTime(iso: string | Date, form: "full" | "compact" = "full"): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return form === "compact" ? md : `${d.getFullYear()}-${md}`;
}

/** A relative age ("5 分钟前", "yesterday"): the activity form and a date's tooltip. */
export function formatRelative(iso: string | Date, locale: string, now = Date.now()): string {
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
 * as its tooltip. The text depends on the viewer's time zone and the age on the clock, so the
 * server's first paint may differ from the browser's: hydration warnings are suppressed here.
 */
export function DateTime({
  value,
  form = "full",
}: {
  value: string | Date;
  form?: "full" | "compact";
}) {
  const locale = useDesignLocale();
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return <span className="cb-datetime">—</span>;
  return (
    <time
      className="cb-datetime"
      dateTime={typeof value === "string" ? value : value.toISOString()}
      title={formatRelative(d, locale)}
      suppressHydrationWarning
    >
      {formatDateTime(d, form)}
    </time>
  );
}

/** A version as the UI writes it (spec §2.2): mono, always one leading `v` ("v0.1.0-rc.0"). */
export function versionLabel(version: string | number): string {
  const v = String(version);
  return /^v\d/i.test(v) ? `v${v.slice(1)}` : `v${v}`;
}
