/**
 * Plugin page params and links (plugin full pages spec §5): what a full plugin page reads from its
 * address and what the host lets a forwarded component navigate to or link. Pure helpers (the web
 * does not import the SDK: `PAGE_PARAMS_BYTES` copies `UI_LIMITS.pageParamsBytes`).
 */

/** The most UTF-8 bytes of a page's params, all keys and values (`UI_LIMITS.pageParamsBytes`). */
export const PAGE_PARAMS_BYTES = 2048;

const utf8 = new TextEncoder();

/**
 * Params within {@link PAGE_PARAMS_BYTES}: kept in order while they fit, the rest dropped with a
 * console warning (spec §5: longer is dropped).
 */
export function capPageParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  let bytes = 0;
  for (const [k, v] of Object.entries(params)) {
    const size = utf8.encode(k).length + utf8.encode(v).length;
    if (bytes + size > PAGE_PARAMS_BYTES) {
      dropped.push(k);
      continue;
    }
    bytes += size;
    out[k] = v;
  }
  if (dropped.length > 0) {
    console.warn(
      `plugin page params over ${PAGE_PARAMS_BYTES} bytes: dropped ${dropped.map((k) => JSON.stringify(k)).join(", ")}`,
    );
  }
  return out;
}

/**
 * A page's params from its address: each name's first value (a repeated name keeps its first),
 * capped by {@link capPageParams}. Takes the browser's search params or a server page's
 * `searchParams` record.
 */
export function pageParamsOf(
  search: URLSearchParams | Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (search instanceof URLSearchParams) {
    for (const [k, v] of search) if (!Object.hasOwn(out, k)) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(search)) {
      const first = Array.isArray(v) ? v[0] : v;
      if (first !== undefined) out[k] = first;
    }
  }
  return capPageParams(out);
}

/** `?a=1&b=2` for the params, `""` for none. */
export function searchOf(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q === "" ? "" : `?${q}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A plain object whose values are all strings, or strings and null when `nulls`. */
export function isParamRecord(v: unknown, nulls: boolean): v is Record<string, string | null> {
  return (
    isPlainObject(v) &&
    Object.values(v).every((x) => typeof x === "string" || (nulls && x === null))
  );
}

/** `current` with `changes` applied: a string sets a param, `null` removes it. */
export function applyParamChanges(
  current: Record<string, string>,
  changes: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = { ...current };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * A link a forwarded component may carry: a same-origin path (`/x`, not `//host`), a query or a
 * fragment of this page, or an absolute http(s) URL. Anything else (`javascript:`, `data:`, other
 * schemes, protocol-relative URLs) is undefined.
 */
export function safeHref(href: unknown): string | undefined {
  // browsers strip tabs and newlines from a URL (`/\t/host` is `//host`): no control characters
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters this refuses
  if (typeof href !== "string" || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  if (href.startsWith("/")) return /^\/[/\\]/.test(href) ? undefined : href;
  if (href.startsWith("?") || href.startsWith("#")) return href;
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
}
