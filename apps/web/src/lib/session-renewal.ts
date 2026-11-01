import { createHash } from "node:crypto";
import { kernelUrl } from "./kernel-proxy";

/**
 * Session renewal for the proxy (`src/proxy.ts`): exchanges a refresh token for a new cookie pair at
 * `POST /api/v1/auth/refresh`. Pure of Next, so it is tested without a server.
 */

/** The outcome of one refresh. */
export type Renewal =
  | { kind: "renewed"; setCookies: string[]; accessToken: string }
  | { kind: "race" }
  | { kind: "invalid"; setCookies: string[] }
  | { kind: "unavailable" };

/**
 * How long a renewal is reused for the same old token: the kernel's own race window, so prefetches
 * and parallel tabs arriving with the old token get the same new pair.
 */
export const REFRESH_RACE_GRACE_MS = 30_000;

/** Who is renewing: the trusted client address (`lib/peer.ts`) and the browser's user agent. */
export interface RenewalClient {
  peer?: string | undefined;
  userAgent?: string | undefined;
}

/** How long the proxy waits for the kernel before treating it as unavailable. */
const REFRESH_TIMEOUT_MS = 5_000;

/**
 * Single flight per refresh token, per process by design (a pure function of the token, not shared
 * state: another replica may refresh the same token). `expires` is `Infinity` while in flight.
 */
const flights = new Map<string, { promise: Promise<Renewal>; expires: number }>();

/** The cache key of a refresh token: its sha256, so the map never holds the token itself. */
export const renewalKey = (refreshToken: string): string =>
  createHash("sha256").update(refreshToken).digest("hex");

/** Tests only: forget every flight. */
export function resetRenewals(): void {
  flights.clear();
}

/** The value of the named cookie in a list of `Set-Cookie` headers, ignoring clears. */
export function setCookieValue(setCookies: readonly string[], name: string): string | undefined {
  for (const c of setCookies) {
    const pair = c.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    const value = pair.slice(eq + 1).trim();
    if (value !== "" && !/;\s*max-age=0\s*(;|$)/i.test(c)) return value;
  }
  return undefined;
}

async function callKernel(refreshToken: string, client: RenewalClient): Promise<Renewal> {
  const headers = new Headers({ cookie: `cap_rt=${refreshToken}`, "x-capybara-csrf": "1" });
  if (client.peer !== undefined) headers.set("x-forwarded-for", client.peer);
  // the kernel records the user agent on the session; without it Node's own would replace it
  if (client.userAgent !== undefined) headers.set("user-agent", client.userAgent);
  let res: Response;
  try {
    res = await fetch(`${kernelUrl()}/api/v1/auth/refresh`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (res.ok) {
    const setCookies = res.headers.getSetCookie();
    const accessToken = setCookieValue(setCookies, "cap_at");
    await res.body?.cancel().catch(() => {});
    return accessToken === undefined
      ? { kind: "unavailable" }
      : { kind: "renewed", setCookies, accessToken };
  }
  // 401 / 403 are the kernel's verdict on the token; anything else (429, 5xx) is not
  if (res.status !== 401 && res.status !== 403) {
    await res.body?.cancel().catch(() => {});
    return { kind: "unavailable" };
  }
  let code: unknown;
  try {
    code = ((await res.json()) as { error?: { code?: unknown } }).error?.code;
  } catch {
    code = undefined;
  }
  return code === "auth.refresh_race"
    ? { kind: "race" }
    : { kind: "invalid", setCookies: res.headers.getSetCookie() };
}

/**
 * Renews the session of `refreshToken`. Concurrent calls with one token share one kernel call; a
 * `renewed` result is reused for {@link REFRESH_RACE_GRACE_MS} after it settles, other results only
 * while in flight. `client` is passed on to the kernel (concurrent callers share the first one's).
 */
export function renewSession(refreshToken: string, client: RenewalClient): Promise<Renewal> {
  const now = Date.now();
  for (const [k, v] of flights) if (v.expires <= now) flights.delete(k);
  const key = renewalKey(refreshToken);
  const existing = flights.get(key);
  if (existing !== undefined) return existing.promise;
  const entry = { promise: callKernel(refreshToken, client), expires: Number.POSITIVE_INFINITY };
  flights.set(key, entry);
  void entry.promise.then((r) => {
    if (flights.get(key) !== entry) return;
    if (r.kind === "renewed") entry.expires = Date.now() + REFRESH_RACE_GRACE_MS;
    else flights.delete(key);
  });
  return entry.promise;
}
