/** Web search extension point ref (`web-search@1`). */
export const WEB_SEARCH_EXTENSION_POINT = "web-search@1";

/** Web fetch extension point ref (`web-fetch@1`). */
export const WEB_FETCH_EXTENSION_POINT = "web-fetch@1";

/** One search hit. */
export interface WebSearchResult {
  title: string;
  /** Absolute http / https URL. */
  url: string;
  /** Plain text or markdown, trimmed by the provider. */
  snippet?: string;
  /** ISO 8601 date or datetime, when known. */
  publishedAt?: string;
}

/**
 * A web search provider (`web-search@1`). The kernel passes the org's decrypted `orgConfig` and the
 * extension's effective deployment config for the org (`config`).
 */
export interface WebSearchProvider {
  /**
   * False when this org's config lacks what the provider needs. `config` is the effective
   * deployment config for the org (see `search`'s `config`).
   */
  configured?(orgConfig: unknown, config?: unknown): boolean;
  search(args: {
    query: string;
    /** Hints only: the kernel filters the results again. */
    allowedDomains?: string[];
    blockedDomains?: string[];
    maxResults: number;
    orgConfig: unknown;
    /**
     * The extension's effective deployment config for this org: the platform's deployment config
     * with the org's copy applied to the overridable fields (`orgAccess(…, "override")`), or the
     * platform's config (equal to `ctx.config`) while the org follows it. Use it, not `ctx.config`,
     * for work done for this org. Optional in the type so older extensions compile; the kernel
     * always passes it.
     */
    config?: unknown;
    signal: AbortSignal;
  }): Promise<{ results: WebSearchResult[] }>;
}

/** A fetched page, converted to markdown. */
export interface WebFetchPage {
  /** After redirects; equal to the requested URL when there were none. */
  finalUrl: string;
  title?: string;
  markdown: string;
  contentType?: string;
}

/**
 * A web fetch provider (`web-fetch@1`).
 *
 * The kernel checks the URL it passes and the returned `finalUrl` without DNS: it refuses IP
 * literals in private, loopback, link-local or reserved ranges and single-label or `localhost`
 * names. A provider that fetches from inside the deployment (rather than through a remote
 * service) must also refuse non-public addresses after DNS resolution, for the URL and for every
 * redirect it follows. It may reuse the kernel's rules: {@link isPublicHostname} on
 * `new URL(url).hostname` (never a hand-parsed host), and on each resolved address it connects
 * to (an IPv6 address in brackets, as in a URL).
 */
export interface WebFetchProvider {
  /**
   * False when this org's config lacks what the provider needs. `config` is the effective
   * deployment config for the org (see `fetch`'s `config`).
   */
  configured?(orgConfig: unknown, config?: unknown): boolean;
  fetch(args: {
    /** Already validated and upgraded by the kernel. */
    url: string;
    orgConfig: unknown;
    /**
     * The extension's effective deployment config for this org: the platform's deployment config
     * with the org's copy applied to the overridable fields (`orgAccess(…, "override")`), or the
     * platform's config (equal to `ctx.config`) while the org follows it. Use it, not `ctx.config`,
     * for work done for this org. Optional in the type so older extensions compile; the kernel
     * always passes it.
     */
    config?: unknown;
    signal: AbortSignal;
  }): Promise<WebFetchPage>;
}

/**
 * Why a web provider call failed: `not_found` (404 / no content), `blocked` (the site refused the
 * provider), `auth` (bad credentials), `rate_limited`, `unavailable` (provider down, 5xx, timeout),
 * `invalid` (the provider rejected the query or URL).
 */
export type WebProviderErrorKind =
  | "not_found"
  | "blocked"
  | "auth"
  | "rate_limited"
  | "unavailable"
  | "invalid";

/** Thrown by web providers; the kernel maps `kind` to fixed, model-visible error text. */
export class WebProviderError extends Error {
  readonly kind: WebProviderErrorKind;
  constructor(message: string, opts: { kind: WebProviderErrorKind }) {
    super(message);
    this.name = "WebProviderError";
    this.kind = opts.kind;
  }
}

function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : undefined;
}

function isPublicIpv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Parses an IPv6 literal (no brackets) into eight 16-bit groups, or undefined. */
function ipv6Groups(host: string): number[] | undefined {
  let s = host;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = ipv4Octets(tail[1] as string);
    if (!o) return undefined;
    s = `${s.slice(0, tail.index)}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(
      ((o[2] as number) << 8) | (o[3] as number)
    ).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/i.test(s) || s.split("::").length > 2) return undefined;
  const [head = "", rest] = s.split("::");
  const h = head === "" ? [] : head.split(":");
  const t = rest === undefined || rest === "" ? [] : rest.split(":");
  const parts = [...h, ...t];
  if (!parts.every((p) => /^[0-9a-f]{1,4}$/i.test(p))) return undefined;
  let groups: string[];
  if (rest === undefined) {
    if (h.length !== 8) return undefined;
    groups = h;
  } else {
    if (h.length + t.length > 7) return undefined;
    groups = [...h, ...new Array<string>(8 - h.length - t.length).fill("0"), ...t];
  }
  return groups.map((g) => Number.parseInt(g, 16));
}

function isPublicIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeros5 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeros5 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return false; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded address.
  if (zeros5 && (g5 === 0xffff || g5 === 0)) {
    return isPublicIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0064 && g1 === 0xff9b) return isPublicIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // NAT64
  if (g0 === 0x2002) return isPublicIpv4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]); // 6to4
  return true;
}

/**
 * Whether a URL hostname can name a public internet host. Pure, no DNS: false for `localhost`,
 * single-label names, `*.localhost` / `*.local` / `*.internal`, and IP literals (IPv6 in brackets,
 * as in a URL) in private, loopback, link-local, CGNAT, multicast, unspecified, documentation and
 * reserved ranges, including IPv4-mapped IPv6. A name that resolves to a private address is not
 * detected here.
 */
export function isPublicHostname(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "") return false;
  if (h.startsWith("[")) {
    if (!h.endsWith("]")) return false;
    const g = ipv6Groups(h.slice(1, -1));
    return g !== undefined && isPublicIpv6(g);
  }
  const o = ipv4Octets(h);
  if (o) return isPublicIpv4(o);
  if (/^[\d.]+$/.test(h)) return false; // malformed or shorthand numeric host
  if (!h.includes(".")) return false;
  if (h === "localhost" || /\.(localhost|local|internal)$/.test(h)) return false;
  return true;
}
