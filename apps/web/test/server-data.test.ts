import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The request scope of a server render: `next/headers` reads `req`, and `React.cache` memoizes per
// `scope` (reset before each test, as each test is one request).
const req = vi.hoisted(() => ({ headers: new Headers(), scope: new Map<unknown, unknown>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  cache:
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (!req.scope.has(fn)) req.scope.set(fn, new Map<string, R>());
      const memo = req.scope.get(fn) as Map<string, R>;
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key) as R;
    },
}));

const { apiFetch, setApiTransport } = await import("../src/lib/api");
const { serverTransport } = await import("../src/lib/server/kernel");
const { getShell } = await import("../src/lib/server/session");
const { getMe } = await import("../src/lib/session");
const { PEER_TOKEN_ENV, PEER_TOKEN_HEADER } = await import("../src/lib/peer");
const { isPublicPath, isAdminPath } = await import("../src/lib/routes");

type Route = (init?: RequestInit) => Response;
const json = (status: number, body: unknown) => Response.json(body, { status });
const err = (status: number, code: string) => json(status, { error: { code, message: code } });

/** Stubs the kernel behind `fetch`: `GET <path>` → response; returns the calls. */
function kernel(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      const path = input.replace("http://localhost:8080", "");
      const route = routes[path];
      if (route === undefined) throw new Error(`unexpected ${path}`);
      return route(init);
    }),
  );
  return calls;
}

const ME = {
  account: { id: "a1", displayName: "Grant", email: null, isSuperAdmin: false },
  via: "session",
  currentOrgId: "o1",
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
  canCreateOrg: true,
};
const READY = { modelProvider: "ready", agents: 1 };

beforeEach(() => {
  req.headers = new Headers({ cookie: "cap_at=t1", "x-cap-path": "/agents?tab=mine" });
  req.scope = new Map();
  setApiTransport(serverTransport);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setApiTransport(null);
});

describe("apiFetch on the server", () => {
  it("throws without a registered transport", async () => {
    setApiTransport(null);
    await expect(apiFetch("/api/v1/me")).rejects.toThrow(
      "apiFetch on the server without a transport",
    );
  });

  it("does not retry a 401 through a refresh", async () => {
    const calls = kernel({ "/api/v1/me": () => err(401, "auth.token_expired") });
    await expect(getMe()).rejects.toMatchObject({ status: 401, code: "auth.token_expired" });
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:8080/api/v1/me"]);
  });
});

describe("serverTransport", () => {
  it("forwards the cookie, language, request id and trusted peer; never cached", async () => {
    vi.stubEnv(PEER_TOKEN_ENV, "tok");
    req.headers = new Headers({
      cookie: "cap_at=t1; cap_rt=r1",
      "accept-language": "zh",
      "x-request-id": "req-1",
      "x-forwarded-for": "203.0.113.9",
      [PEER_TOKEN_HEADER]: "tok",
      "user-agent": "secret-ish",
    });
    const calls = kernel({ "/api/v1/me": () => json(200, ME) });
    expect(await getMe()).toEqual(ME);
    const init = calls[0]?.init;
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(init?.headers);
    expect(h.get("cookie")).toBe("cap_at=t1; cap_rt=r1");
    expect(h.get("accept-language")).toBe("zh");
    expect(h.get("x-request-id")).toBe("req-1");
    expect(h.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(h.get("user-agent")).toBeNull();
    expect(h.get(PEER_TOKEN_HEADER)).toBeNull();
  });

  it("drops an untrusted x-forwarded-for", async () => {
    req.headers = new Headers({ cookie: "c=1", "x-forwarded-for": "6.6.6.6" });
    const calls = kernel({ "/api/v1/me": () => json(200, ME) });
    await getMe();
    expect(new Headers(calls[0]?.init?.headers).get("x-forwarded-for")).toBeNull();
  });

  it("refuses anything but GET", async () => {
    const calls = kernel({});
    await expect(serverTransport("/api/v1/orgs", { method: "POST", body: "{}" })).rejects.toThrow(
      /GET/,
    );
    expect(calls).toHaveLength(0);
  });

  it("deduplicates GETs of one path within a request, each caller reading its own body", async () => {
    const calls = kernel({ "/api/v1/me": () => json(200, ME) });
    const [a, b] = await Promise.all([getMe(), getMe()]);
    expect(a).toEqual(ME);
    expect(b).toEqual(ME);
    expect(calls).toHaveLength(1);
    // a new request reads again
    req.scope = new Map();
    await getMe();
    expect(calls).toHaveLength(2);
  });

  it("throws upstream_unavailable without calling the kernel when the proxy saw it down", async () => {
    req.headers.set("x-cap-session", "unavailable");
    const calls = kernel({});
    await expect(getMe()).rejects.toMatchObject({ status: 0, code: "upstream_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("maps a failed fetch to network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(getMe()).rejects.toMatchObject({ status: 0, code: "network" });
  });
});

describe("getShell", () => {
  it("reads the shell in parallel; optional reads fall back to null", async () => {
    const calls = kernel({
      "/api/v1/me": () => json(200, ME),
      "/api/v1/orgs/o1/readiness": () => json(200, READY),
      "/api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
      "/api/v1/orgs/o1/inbox": () => json(200, { items: [{}, {}], truncated: true }),
      "/api/v1/orgs/o1/ui/contributions": () => err(500, "internal"),
    });
    const shell = await getShell();
    expect(shell).toEqual({
      kind: "ready",
      me: ME,
      org: ME.memberships[0],
      readiness: READY,
      groups: { groups: [], next: null },
      pending: { count: 2, more: true },
      extensions: null,
    });
    expect(calls).toHaveLength(5);
  });

  it("keeps only page contributions", async () => {
    kernel({
      "/api/v1/me": () => json(200, ME),
      "/api/v1/orgs/o1/readiness": () => json(200, READY),
      "/api/v1/orgs/o1/conversations/groups": () => err(500, "internal"),
      "/api/v1/orgs/o1/inbox": () => err(500, "internal"),
      "/api/v1/orgs/o1/ui/contributions": () =>
        json(200, {
          items: [
            { id: "p", place: "page" },
            { id: "s", place: "section" },
          ],
        }),
    });
    expect(await getShell()).toMatchObject({
      groups: null,
      pending: null,
      extensions: [{ id: "p", place: "page" }],
    });
  });

  it("has no readiness and no org reads without a current org", async () => {
    const calls = kernel({ "/api/v1/me": () => json(200, { ...ME, currentOrgId: null }) });
    expect(await getShell()).toMatchObject({
      kind: "ready",
      org: null,
      readiness: null,
      groups: null,
      pending: null,
      extensions: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("returns unavailable when the kernel can't answer me", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await getShell()).toEqual({ kind: "unavailable" });
    req.scope = new Map();
    req.headers.set("x-cap-session", "unavailable");
    expect(await getShell()).toEqual({ kind: "unavailable" });
  });

  it("redirects to sign-in when an optional shell read gets 401 auth.*", async () => {
    kernel({
      "/api/v1/me": () => json(200, ME),
      "/api/v1/orgs/o1/readiness": () => json(200, READY),
      "/api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
      "/api/v1/orgs/o1/inbox": () => err(401, "auth.required"),
      "/api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    });
    await expect(getShell()).rejects.toThrow(/REDIRECT \/login/);
  });

  it("returns unavailable when an optional shell read finds the kernel down", async () => {
    kernel({
      "/api/v1/me": () => json(200, ME),
      "/api/v1/orgs/o1/readiness": () => json(200, READY),
      "/api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
      "/api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
      "/api/v1/orgs/o1/ui/contributions": () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await getShell()).toEqual({ kind: "unavailable" });
  });

  it("throws when readiness fails for another reason", async () => {
    kernel({
      "/api/v1/me": () => json(200, ME),
      "/api/v1/orgs/o1/readiness": () => err(500, "internal"),
      "/api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
      "/api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
      "/api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    });
    await expect(getShell()).rejects.toMatchObject({ status: 500, code: "internal" });
  });
});

describe("routes", () => {
  it("classifies public and admin paths", () => {
    for (const p of ["/login", "/login/sso", "/setup", "/invite/abc", "/bind"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of ["/", "/loginx", "/agents", "/admin"]) expect(isPublicPath(p)).toBe(false);
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/accounts")).toBe(true);
    expect(isAdminPath("/administer")).toBe(false);
  });
});
