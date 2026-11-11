/**
 * Number helpers shared by the design components and pages (spec §2.2; admin overview design
 * §8.2). Counts stay in full with `en-US` grouping; large measures such as tokens are compact.
 */

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** The compact units of a locale, largest first: the factor and its suffix. */
const UNITS: Record<"zh" | "en", [number, string][]> = {
  en: [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ],
  zh: [
    [1e12, "万亿"],
    [1e8, "亿"],
    [1e4, "万"],
  ],
};

/** One decimal below 100 of a unit, none from 100 up ("12.3K", "123K", "3.4M", "346万"). */
function scaled(abs: number, unit: number): number {
  const v = abs / unit;
  return v < 100 ? Math.round(v * 10) / 10 : Math.round(v);
}

/**
 * A large number in the reader's locale, at most one decimal: en `3.4M` / `12.3K`, zh `340万` /
 * `1.2万` / `1亿` (zh counts in 万 and 亿, so 1,000 stays `1,000`). Below the first unit the number
 * is grouped as counts are (`999`, zh `9,999`). A value that rounds up to the next unit takes it
 * (`999,950` → `1M`). Not a finite number: `—`.
 */
export function formatCompact(n: number, locale: string): string {
  if (!Number.isFinite(n)) return "—";
  const units = UNITS[locale === "zh" || locale.startsWith("zh-") ? "zh" : "en"];
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  for (let k = 0; k < units.length; k++) {
    const [unit, suffix] = units[k] as [number, string];
    if (abs < unit) continue;
    const bigger = units[k - 1];
    const v = scaled(abs, unit);
    if (bigger && v * unit >= bigger[0]) {
      return `${sign}${String(scaled(abs, bigger[0]))}${bigger[1]}`;
    }
    return `${sign}${String(v)}${suffix}`;
  }
  // below the smallest unit; a value that rounds up to it takes it
  const smallest = units[units.length - 1] as [number, string];
  const rounded = Math.round(abs * 10) / 10;
  if (rounded >= smallest[0]) return `${sign}1${smallest[1]}`;
  return `${sign}${GROUPED.format(rounded)}`;
}
