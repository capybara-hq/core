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
 * The document CSP (client extensions spec §9.5): scripts only from this origin or carrying the
 * request's nonce (Next puts it on its own inline flight scripts), no plugins (`<object>`,
 * `<embed>`), no `<base>`. Dev adds `'unsafe-eval'`, which React's dev build and Turbopack's
 * hot reload need; production never allows eval or `'unsafe-inline'`. `style-src`, `connect-src`,
 * `img-src`, `font-src` and `frame-src` stay unrestricted for now (full trust, D2; the design system
 * uses inline styles); `/plugin-ui` embeds are separate documents with their own sandbox CSP.
 */
export function documentPolicy(nonce: string, dev: boolean): string {
  const script = ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])];
  return [`script-src ${script.join(" ")}`, "object-src 'none'", "base-uri 'none'"].join("; ");
}

/** A fresh nonce: 16 random bytes, base64 (Web Crypto, so it runs wherever the proxy runs). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
