/**
 * The UI languages. The language is not in the URL: it lives in the `NEXT_LOCALE` cookie (set by the
 * language picker), else follows the browser's Accept-Language, else `zh` (`request.ts`).
 */
export const routing = {
  locales: ["zh", "en"],
  defaultLocale: "zh",
} as const;

export type AppLocale = (typeof routing.locales)[number];

/** The cookie holding the chosen language (next-intl's conventional name). */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (routing.locales as readonly string[]).includes(value);
}

/**
 * The best supported language for an `Accept-Language` header (by q-value, then order; `zh-CN`
 * matches `zh`), or undefined when none matches.
 */
export function negotiateLocale(header: string | null | undefined): AppLocale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((r) => r.tag !== "" && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const r of ranked) {
    const base = r.tag.split("-")[0];
    if (isAppLocale(base)) return base;
  }
  return undefined;
}

/** The value written to `document.cookie` to choose `locale` for a year. */
export const localeCookie = (locale: AppLocale) =>
  `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
