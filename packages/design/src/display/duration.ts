import { type Locale, messages } from "../i18n";

export type DurationOptions = {
  /**
   * A timer that ticks each second while something runs: whole seconds rounded down, so it reads
   * like a counter ("3 秒", never "3.4 秒") and never runs ahead of the clock.
   */
  live?: boolean;
};

const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A duration in the UI language (spec §7, browser review F29): the one formatter for every time a
 * page shows (the status bar's 已用, the run row, a tool's elapsed and finished time, sub-agents,
 * background tasks), so the same span reads the same everywhere. Below 10 s one decimal ("2.1 秒" /
 * "2.1s"; a `live` timer whole seconds), then whole seconds ("42 秒" / "42s"), minutes and padded
 * seconds ("1 分 09 秒" / "1m 09s"), hours and padded minutes ("1 小时 02 分" / "1h 02m").
 */
export function formatDuration(ms: number, locale: Locale, options: DurationOptions = {}): string {
  const t = messages[locale];
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  // 9.95 s and above would round to "10.0": whole seconds from there
  if (!options.live && v < 9_950) {
    return fill(t["duration.s"], { s: (Math.round(v / 100) / 10).toFixed(1) });
  }
  const total = options.live ? Math.floor(v / 1000) : Math.round(v / 1000);
  if (total < 60) return fill(t["duration.s"], { s: total });
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return fill(t["duration.hm"], { h, m: pad(m) });
  return fill(t["duration.ms"], { m, s: pad(total % 60) });
}
