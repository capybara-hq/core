/**
 * Request headers the proxy (`src/proxy.ts`) sets for server code. They are trusted internal
 * headers: the proxy strips any client-sent copy before setting its own. Kept free of
 * `server-only` so the proxy can import them.
 */

/** Set by the proxy when the kernel could not renew or check the session (`unavailable`). */
export const SESSION_STATE_HEADER = "x-cap-session";

/** The request's path and query, as the proxy recorded it. */
export const PATH_HEADER = "x-cap-path";

/**
 * The document's CSP nonce (16 random bytes, base64), fresh per document request; the layouts read
 * it (`currentNonce()` in `lib/server/page.ts`) for the scripts they render themselves.
 */
export const NONCE_HEADER = "x-nonce";

/** The CSP header: set on the forwarded request (Next takes its nonce from there) and the response. */
export const CSP_HEADER = "content-security-policy";

/**
 * The same-origin paths document scripts may load from (besides the nonce): Next's chunks and the
 * client extension bundles (client extensions spec §9.2). Never all of `'self'`: the origin also
 * serves user content (object-store proxy objects, artifacts) that must not run as script.
 */
export const SCRIPT_PATHS: readonly string[] = ["/_next/", "/api/v1/client/"];

/** A host a CSP host-source can name: a DNS name or IPv4 address, optionally with a port. */
const CSP_HOST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::\d{1,5})?$/;

/**
 * The host the browser addressed, for the CSP's script sources: the first `X-Forwarded-Host` value
 * when present and nameable by a CSP host-source (a reverse proxy that rewrites `Host`; Next's
 * server-action origin check reads it the same way), else `Host`. Undefined when neither is present.
 * server.mjs drops every client-sent forwarding header (`lib/peer.ts`), so behind it only `Host`
 * reaches here: a reverse proxy must forward the original `Host` (docs/deploy/README.md).
 */
export function documentHost(headers: Headers): string | undefined {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded !== undefined && CSP_HOST.test(forwarded)) return forwarded;
  return headers.get("host") ?? undefined;
}

/**
 * The document CSP (client extensions spec §9.5, with the 2026-11-09 review rulings):
 * - `script-src`: {@link SCRIPT_PATHS} on the document's host, plus the request's nonce (Next puts it
 *   on its own inline and chunk scripts). The sources carry no scheme, so they follow the page's
 *   (an https page loads https only), which keeps them right behind a TLS-terminating proxy. A host
 *   a CSP source cannot name (an IPv6 literal, garbage) gets no path sources: only the nonce.
 *   Dev adds `'unsafe-eval'` (React's dev Flight client evals); production never allows eval or
 *   `'unsafe-inline'`.
 * - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'self'` (no framing by other sites),
 *   `form-action 'self'` (every form posts to its own page).
 * `style-src`, `connect-src`, `img-src`, `font-src` and `frame-src` stay unrestricted for now (full
 * trust, D2; the design system uses inline styles); `/plugin-ui` embeds are separate documents with
 * their own sandbox CSP.
 */
export function documentPolicy({
  nonce,
  host,
  dev,
}: {
  nonce: string;
  /** The document's host as the browser addressed it (the `Host` header). */
  host: string;
  dev: boolean;
}): string {
  const paths = CSP_HOST.test(host) ? SCRIPT_PATHS.map((p) => `${host.toLowerCase()}${p}`) : [];
  const script = [...paths, `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])];
  return [
    `script-src ${script.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** A fresh nonce: 16 random bytes, base64 (Web Crypto, so it runs wherever the proxy runs). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
