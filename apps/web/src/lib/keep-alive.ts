/**
 * The web tier's HTTP keep-alive timeout (server.mjs; erasable TypeScript only, so server.mjs imports
 * it through Node's type stripping).
 *
 * Node closes an idle keep-alive connection after `keepAliveTimeout` plus `keepAliveTimeoutBuffer`
 * (5 s + 1 s by default). A client that reuses the connection at that moment gets ECONNRESET before
 * its request reaches Next: a load balancer or proxy in front of the web tier answers 502, and a
 * client without idempotent-request retries fails (issue #60: Playwright's `page.request` after
 * 6 s idle). The server must therefore keep idle connections longer than any client in front of it,
 * such as the 60 s idle timeout of AWS ALB and of many nginx setups.
 */

import type { Server } from "node:http";

/** The environment variable that overrides the keep-alive timeout, in milliseconds. */
export const KEEP_ALIVE_ENV = "CAPYBARA_WEB_KEEP_ALIVE_TIMEOUT_MS";

/** Default: above the common 60 s idle timeout of load balancers and proxies. */
export const DEFAULT_KEEP_ALIVE_MS = 65_000;

/**
 * Parses CAPYBARA_WEB_KEEP_ALIVE_TIMEOUT_MS: a positive integer of milliseconds; unset or empty
 * means {@link DEFAULT_KEEP_ALIVE_MS}. Anything else throws, which stops the web tier at startup.
 */
export function parseKeepAliveTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_KEEP_ALIVE_MS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${KEEP_ALIVE_ENV} must be a positive integer of milliseconds, got "${raw}"`);
  }
  return n;
}

/**
 * Applies the keep-alive timeout to the server. `headersTimeout` is raised to stay above it, so
 * the next request on a connection idle for nearly the whole timeout is not cut off by the
 * headers timer.
 */
export function applyKeepAlive(server: Server, ms: number): void {
  server.keepAliveTimeout = ms;
  server.headersTimeout = Math.max(server.headersTimeout, ms + 1_000);
}
