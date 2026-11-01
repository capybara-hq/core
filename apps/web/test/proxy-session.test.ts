import { createHash } from "node:crypto";
import * as staticInfo from "next/dist/build/analysis/get-page-static-info";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATH_HEADER, SESSION_STATE_HEADER } from "../src/lib/headers";
import { PEER_TOKEN_ENV, PEER_TOKEN_HEADER } from "../src/lib/peer";
import { REFRESH_RACE_GRACE_MS, renewSession, resetRenewals } from "../src/lib/session-renewal";
import proxy, { config } from "../src/proxy";

const KERNEL = "http://localhost:8080";
const WEB = "http://web.example";

/** The Set-Cookie headers the kernel answers a successful refresh with. */
const RENEWED_COOKIES = [
  "cap_at=new-at; Max-Age=900; Path=/; HttpOnly; SameSite=Lax",
  "cap_rt=new-rt; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict",
  "cap_rt=; Max-Age=0; Path=/api/v1/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
];

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[];
let refresh: () => Promise<Response>;
let setup: () => Promise<Response>;

const renewed = () => {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of RENEWED_COOKIES) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ account: { id: "a1" } }), { status: 200, headers });
};
/** The Set-Cookie headers the kernel clears the session with (its 401 on an invalid token). */
const CLEARED_COOKIES = [
  "cap_at=; Max-Age=0; Path=/; Secure",
  "cap_rt=; Max-Age=0; Path=/; Secure",
  "cap_rt=; Max-Age=0; Path=/api/v1/auth; Secure",
];
const kernelError = (status: number, code: string, setCookies: string[] = []) => {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ error: { code, message: "x" } }), { status, headers });
};

beforeEach(() => {
  resetRenewals();
  calls = [];
  refresh = async () => renewed();
  setup = async () => Response.json({ needsSetup: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === `${KERNEL}/api/v1/auth/refresh`) return refresh();
      if (url === `${KERNEL}/api/v1/setup`) return setup();
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env[PEER_TOKEN_ENV];
});

const page = (path: string, cookie?: string, extra: Record<string, string> = {}) =>
  new NextRequest(`${WEB}${path}`, {
    headers: { ...(cookie !== undefined && { cookie }), ...extra },
  });

/** The request headers a `NextResponse.next({ request: { headers } })` forwards. */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);
const refreshCalls = () => calls.filter((c) => c.url.endsWith("/api/v1/auth/refresh"));

describe("renewSession", () => {
  it("posts the refresh cookie with the CSRF header and the trusted peer; returns the new pair", async () => {
    const r = await renewSession("old-rt", { peer: "203.0.113.9", userAgent: "Browser/1.0" });
    expect(r).toEqual({ kind: "renewed", setCookies: RENEWED_COOKIES, accessToken: "new-at" });
    const call = refreshCalls()[0] as Call;
    expect(call.init?.method).toBe("POST");
    const h = new Headers(call.init?.headers);
    expect(h.get("cookie")).toBe("cap_rt=old-rt");
    expect(h.get("x-capybara-csrf")).toBe("1");
    expect(h.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(h.get("user-agent")).toBe("Browser/1.0");
    expect(call.init?.cache).toBe("no-store");
  });

  it("five concurrent calls with one token make one kernel call and share its result", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => renewSession("old-rt", {})));
    expect(refreshCalls()).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ kind: "renewed", accessToken: "new-at" });
  });

  it("keeps a renewal for the race grace period, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await renewSession("old-rt", {});
    vi.setSystemTime(Date.now() + REFRESH_RACE_GRACE_MS - 1);
    await renewSession("old-rt", {});
    expect(refreshCalls()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2);
    await renewSession("old-rt", {});
    expect(refreshCalls()).toHaveLength(2);
    await renewSession("other-rt", {});
    expect(refreshCalls()).toHaveLength(3);
  });

  it("maps kernel answers: race, invalid, disabled, 5xx and network errors; none of them is kept", async () => {
    refresh = async () => kernelError(401, "auth.refresh_race");
    expect(await renewSession("t", {})).toEqual({ kind: "race" });
    refresh = async () => kernelError(401, "auth.refresh_invalid");
    expect(await renewSession("t", {})).toEqual({ kind: "invalid", setCookies: [] });
    refresh = async () => kernelError(401, "auth.account_disabled", CLEARED_COOKIES);
    expect(await renewSession("t", {})).toEqual({ kind: "invalid", setCookies: CLEARED_COOKIES });
    refresh = async () => kernelError(503, "unavailable");
    expect(await renewSession("t", {})).toEqual({ kind: "unavailable" });
    refresh = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await renewSession("t", {})).toEqual({ kind: "unavailable" });
    expect(refreshCalls()).toHaveLength(5);
  });

  it("keys the cache by the token's sha256, never the token itself", async () => {
    const { renewalKey } = await import("../src/lib/session-renewal");
    expect(renewalKey("old-rt")).toBe(createHash("sha256").update("old-rt").digest("hex"));
  });
});

describe("proxy: session renewal", () => {
  it("renewed: the request continues with the new cookies and the kernel's Set-Cookie pass through", async () => {
    const res = await proxy(page("/agents", "theme=dark; cap_rt=old-rt; cap_retry=1"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwarded(res, "cookie")).toBe("theme=dark; cap_retry=1; cap_at=new-at; cap_rt=new-rt");
    const set = res.headers.getSetCookie();
    expect(set.slice(0, 3)).toEqual(RENEWED_COOKIES);
    expect(set).toContainEqual(expect.stringMatching(/^cap_retry=; .*Max-Age=0/));
  });

  it("passes the browser's user agent to the kernel, which records it on the session", async () => {
    await proxy(page("/agents", "cap_rt=old-rt", { "user-agent": "Mozilla/5.0 Test" }));
    expect(new Headers(refreshCalls()[0]?.init?.headers).get("user-agent")).toBe(
      "Mozilla/5.0 Test",
    );
  });

  it("passes the trusted peer address to the kernel", async () => {
    process.env[PEER_TOKEN_ENV] = "tok";
    await proxy(
      page("/agents", "cap_rt=old-rt", {
        [PEER_TOKEN_HEADER]: "tok",
        "x-forwarded-for": "198.51.100.7",
      }),
    );
    expect(new Headers(refreshCalls()[0]?.init?.headers).get("x-forwarded-for")).toBe(
      "198.51.100.7",
    );
  });

  it("five concurrent page requests with one old token make one refresh", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => proxy(page("/agents", "cap_rt=old-rt"))),
    );
    expect(refreshCalls()).toHaveLength(1);
    for (const r of results) expect(forwarded(r, "cookie")).toBe("cap_at=new-at; cap_rt=new-rt");
  });

  it("race without the marker: 307 to the same URL with the marker cookie", async () => {
    refresh = async () => kernelError(401, "auth.refresh_race");
    const res = await proxy(page("/agents?x=1", "cap_rt=old-rt"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${WEB}/agents?x=1`);
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^cap_retry=1; .*Max-Age=10/);
    expect(set[0]).toMatch(/Path=\//);
  });

  it("race with the marker: gives up and continues signed out (the gate sends it to sign in)", async () => {
    refresh = async () => kernelError(401, "auth.refresh_race");
    const res = await proxy(page("/agents", "cap_rt=old-rt; cap_retry=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${WEB}/login?returnTo=%2Fagents`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cap_retry=1"))).toBe(false);
    const pub = await proxy(page("/login", "cap_rt=old-rt; cap_retry=1"));
    expect(pub.headers.get("x-middleware-next")).toBe("1");
  });

  it("invalid: forwards the kernel's own cookie clears verbatim", async () => {
    refresh = async () => kernelError(401, "auth.refresh_invalid", CLEARED_COOKIES);
    const res = await proxy(page("/login", "cap_rt=old-rt"));
    expect(res.headers.getSetCookie()).toEqual(CLEARED_COOKIES);
    expect(forwarded(res, "cookie")).toBeNull();
  });

  it("invalid without kernel clears: continues signed out and clears both cookies", async () => {
    refresh = async () => kernelError(401, "auth.refresh_invalid");
    const res = await proxy(page("/login", "theme=dark; cap_rt=old-rt"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwarded(res, "cookie")).toBe("theme=dark");
    const set = res.headers.getSetCookie();
    expect(set).toContainEqual(expect.stringMatching(/^cap_at=; .*Max-Age=0/));
    expect(set).toContainEqual(expect.stringMatching(/^cap_rt=; .*Max-Age=0/));
    // a protected page also redirects, and the redirect carries the clears
    const gated = await proxy(page("/agents", "cap_rt=old-rt"));
    expect(gated.status).toBe(307);
    expect(gated.headers.getSetCookie()).toContainEqual(expect.stringMatching(/^cap_rt=; /));
  });

  it("network error: marks the request unavailable, leaves the cookies alone and does not gate", async () => {
    refresh = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await proxy(page("/agents", "cap_rt=old-rt"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(forwarded(res, SESSION_STATE_HEADER)).toBe("unavailable");
    expect(forwarded(res, "cookie")).toBe("cap_rt=old-rt");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("a request carrying cap_at is not renewed and clears a leftover marker", async () => {
    const res = await proxy(page("/agents", "cap_at=at; cap_rt=rt; cap_retry=1"));
    expect(refreshCalls()).toHaveLength(0);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^cap_retry=; .*Max-Age=0/)]);
    const plain = await proxy(page("/agents", "cap_at=at"));
    expect(plain.headers.getSetCookie()).toEqual([]);
  });
});

describe("proxy: sign-in gate", () => {
  it("no cookies on a protected page: 307 to sign in, back to the page afterwards", async () => {
    const res = await proxy(page("/agents"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${WEB}/login?returnTo=%2Fagents`);
    const q = await proxy(page("/agents/a1?tab=skills"));
    expect(q.headers.get("location")).toBe(
      `${WEB}/login?returnTo=${encodeURIComponent("/agents/a1?tab=skills")}`,
    );
  });

  it("RSC and prefetch requests get the same redirect", async () => {
    const res = await proxy(page("/agents", undefined, { rsc: "1", "next-router-prefetch": "1" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${WEB}/login?returnTo=%2Fagents`);
  });

  it("a fresh deployment goes to the setup wizard", async () => {
    setup = async () => Response.json({ needsSetup: true });
    const res = await proxy(page("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${WEB}/setup`);
  });

  it("public paths pass without cookies and without asking the kernel", async () => {
    for (const path of ["/login", "/setup", "/invite/abc", "/bind/lark?x=1"]) {
      const res = await proxy(page(path));
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("proxy: forwarded headers", () => {
  it("sets x-cap-path to path + query and drops client-sent internal headers", async () => {
    const res = await proxy(
      page("/login?returnTo=%2Fagents", undefined, {
        [PATH_HEADER]: "/forged",
        [SESSION_STATE_HEADER]: "unavailable",
      }),
    );
    expect(forwarded(res, PATH_HEADER)).toBe("/login?returnTo=%2Fagents");
    expect(forwarded(res, SESSION_STATE_HEADER)).toBeNull();
    const signedIn = await proxy(page("/agents", "cap_at=at", { [SESSION_STATE_HEADER]: "x" }));
    expect(forwarded(signedIn, PATH_HEADER)).toBe("/agents");
    expect(forwarded(signedIn, SESSION_STATE_HEADER)).toBeNull();
  });

  it("the legacy locale prefix still redirects first", async () => {
    const res = await proxy(page("/en/agents?x=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${WEB}/agents?x=1`);
    expect(calls).toHaveLength(0);
  });
});

describe("proxy: matcher", () => {
  // How Next compiles a Proxy matcher (not in its public types).
  const { getMiddlewareMatchers } = staticInfo as unknown as {
    getMiddlewareMatchers: (matcher: unknown, nextConfig: object) => { regexp: string }[];
  };
  const [matcher] = getMiddlewareMatchers(config.matcher, {});
  const re = new RegExp(matcher?.regexp ?? "^$");

  it("runs for pages, never for /api, /plugin-ui, /_next, /dev or files", () => {
    for (const p of ["/", "/agents", "/agents/a1", "/apiary", "/devices", "/zh/agents", "/login"]) {
      expect(re.test(p), p).toBe(true);
    }
    for (const p of [
      "/api/v1/me",
      "/api",
      "/plugin-ui/todo/x",
      "/_next/static/chunk.js",
      "/dev/ui",
      "/favicon.ico",
      "/a/b.png",
    ]) {
      expect(re.test(p), p).toBe(false);
    }
  });
});
