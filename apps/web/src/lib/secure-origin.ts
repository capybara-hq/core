/** The parts of `window` that decide whether the browser keeps Secure session cookies. */
export type OriginInfo = {
  isSecureContext?: boolean;
  location: { protocol: string; hostname: string };
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * True when the page is served over plain http from a host other than localhost: browsers drop the
 * kernel's Secure session cookies there (auth.cookieSecure, default true), so sign-in cannot stick.
 * Uses `isSecureContext` when the browser reports it, otherwise the protocol and host name.
 */
export function secureCookiesBlocked(w: OriginInfo): boolean {
  if (typeof w.isSecureContext === "boolean") return !w.isSecureContext;
  const host = w.location.hostname.toLowerCase();
  return w.location.protocol === "http:" && !LOOPBACK.has(host) && !host.endsWith(".localhost");
}
