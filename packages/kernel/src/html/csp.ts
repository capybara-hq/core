/**
 * The Content-Security-Policy of an HTML document (file sharing spec §4, "Isolation without a
 * second origin"): `sandbox` without `allow-same-origin` makes the document an opaque origin even
 * at the app's own URL (no cookies, no storage, no scripting of its parent); `allow-top-navigation`
 * is never granted. Scripts, styles, fonts and images load inline or from the CDN allowlist only;
 * every connection (fetch, XHR, WebSocket, beacons) is blocked.
 */

/** A bare `https://` origin: what may go into a source list (no spaces, quotes or `;`). */
const SOURCE_RE = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/**
 * The exact spec §4 policy for `allowlist` (directives joined with `"; "`). An entry that is not a
 * bare https origin is dropped (the setting is validated when stored; this keeps a bad row from
 * ever adding a directive).
 */
export function htmlDocumentCsp(allowlist: readonly string[]): string {
  const cdn = allowlist.filter((o) => SOURCE_RE.test(o));
  const src = (...base: string[]) => [...base, ...cdn].join(" ");
  return [
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    src("script-src", "'unsafe-inline'", "'unsafe-eval'"),
    src("style-src", "'unsafe-inline'"),
    src("font-src", "data:"),
    src("img-src", "data:", "blob:"),
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}
