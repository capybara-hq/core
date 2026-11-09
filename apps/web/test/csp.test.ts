import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as staticInfo from "next/dist/build/analysis/get-page-static-info";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiRoute from "../src/app/api/[...path]/route";
import * as pluginUiRoute from "../src/app/plugin-ui/[...path]/route";
import { documentPolicy, NONCE_HEADER } from "../src/lib/headers";
import {
  isObjectStorePath,
  parseObjectStoreProxy,
  proxyObjectStore,
} from "../src/lib/object-store-proxy";
import { EMBED_CSP } from "../src/lib/plugin-ui-proxy";
import { resetRenewals } from "../src/lib/session-renewal";
import proxy, { config } from "../src/proxy";

/**
 * The document CSP (client extensions spec `docs/superpowers/specs/2026-11-09-client-extensions-design.md`
 * §9.5, with the review rulings): the proxy sets `script-src <host>/_next/ <host>/api/v1/client/
 * 'nonce-<n>'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'` with a
 * fresh nonce on every document request (never `'self'`: the origin also serves user content), both on the forwarded request (Next reads the nonce from
 * it and puts it on its own scripts; the layouts read `x-nonce`) and on the response. `/api`,
 * `/plugin-ui`, `/_next` and the object-store proxy keep their own headers.
 */

const server = { req: new Headers() };
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => server.req }));

const WEB = "http://web.example";
/** A signed-in page request (the access cookie is opaque here: no renewal without cap_rt). */
const page = (path: string, extra: Record<string, string> = {}) =>
  new NextRequest(`${WEB}${path}`, { headers: { cookie: "cap_at=at", ...extra } });
/** The request headers a `NextResponse.next({ request: { headers } })` forwards. */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

const NONCE_RE = /^script-src [^;]*'nonce-([A-Za-z0-9+/]{22}==)'/;
const nonceOf = (csp: string | null) => NONCE_RE.exec(csp ?? "")?.[1];

// How Next compiles a Proxy matcher (not in its public types).
const { getMiddlewareMatchers } = staticInfo as unknown as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: object) => { regexp: string }[];
};
const [matcher] = getMiddlewareMatchers(config.matcher, {});
const proxied = (path: string) => new RegExp(matcher?.regexp ?? "^$").test(path);

beforeEach(() => {
  resetRenewals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("document CSP", () => {
  it("a document response carries the policy with a fresh nonce", async () => {
    const a = await proxy(page("/agents"));
    const b = await proxy(page("/agents"));
    for (const res of [a, b]) {
      const csp = res.headers.get("content-security-policy");
      const nonce = nonceOf(csp);
      expect(nonce, String(csp)).toBeDefined();
      expect(csp).toMatch(
        /^script-src web\.example\/_next\/ web\.example\/api\/v1\/client\/ 'nonce-[^']+'/,
      );
      expect(csp).not.toContain("'self' ");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("form-action 'self'");
      // the same policy reaches Next (which applies the nonce to its scripts) and the layouts
      expect(forwarded(res, "content-security-policy")).toBe(csp);
      expect(forwarded(res, NONCE_HEADER)).toBe(nonce);
      // 16 random bytes
      expect(Buffer.from(nonce as string, "base64")).toHaveLength(16);
    }
    expect(nonceOf(a.headers.get("content-security-policy"))).not.toBe(
      nonceOf(b.headers.get("content-security-policy")),
    );
  });

  it("public pages get it too, and a client-sent nonce or policy never survives", async () => {
    const res = await proxy(
      new NextRequest(`${WEB}/login`, {
        headers: {
          [NONCE_HEADER]: "attacker",
          "content-security-policy": "script-src 'nonce-attacker'",
          "content-security-policy-report-only": "script-src 'nonce-attacker'",
        },
      }),
    );
    const nonce = nonceOf(res.headers.get("content-security-policy"));
    expect(nonce).toBeDefined();
    expect(forwarded(res, NONCE_HEADER)).toBe(nonce);
    expect(forwarded(res, "content-security-policy")).not.toContain("attacker");
    // the report-only copy (Next's fallback source of the nonce) is dropped from the request
    expect(res.headers.get("x-middleware-override-headers")?.split(",")).not.toContain(
      "content-security-policy-report-only",
    );
    expect(forwarded(res, "content-security-policy-report-only")).toBeNull();
  });

  it("dev adds unsafe-eval and production does not", async () => {
    const tail = "object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'";
    expect(documentPolicy({ nonce: "abc=", host: "cap.example", dev: false })).toBe(
      `script-src cap.example/_next/ cap.example/api/v1/client/ 'nonce-abc='; ${tail}`,
    );
    expect(documentPolicy({ nonce: "abc=", host: "cap.example", dev: true })).toBe(
      `script-src cap.example/_next/ cap.example/api/v1/client/ 'nonce-abc=' 'unsafe-eval'; ${tail}`,
    );
    vi.stubEnv("NODE_ENV", "production");
    const prod = (await proxy(page("/"))).headers.get("content-security-policy");
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).not.toContain("unsafe-inline");
    vi.stubEnv("NODE_ENV", "development");
    expect((await proxy(page("/"))).headers.get("content-security-policy")).toContain(
      "'unsafe-eval'",
    );
  });

  it("the same path requested twice gets two different nonces", async () => {
    for (const path of ["/settings/organization", "/chat/x.y"]) {
      const [a, b] = await Promise.all([proxy(page(path)), proxy(page(path))]);
      const na = nonceOf(a?.headers.get("content-security-policy") ?? null);
      const nb = nonceOf(b?.headers.get("content-security-policy") ?? null);
      expect(na, path).toBeDefined();
      expect(nb, path).toBeDefined();
      expect(na, path).not.toBe(nb);
    }
  });

  it("scripts come from the host the browser addressed, port included; never 'self'", async () => {
    const res = await proxy(page("/agents", { host: "Capybara.Example.com:8443" }));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(
      /^script-src capybara\.example\.com:8443\/_next\/ capybara\.example\.com:8443\/api\/v1\/client\/ 'nonce-/,
    );
    expect(csp).not.toContain("'self' ");
    expect(csp.split("; ")[0]).not.toContain("'self'");
    // a host no CSP source can name gets the nonce only (never a widened policy)
    for (const host of ["[::1]:3000", "evil.example; script-src *", "a b", ""]) {
      const p = documentPolicy({ nonce: "n=", host, dev: false });
      expect(p.split("; ")[0], host).toBe("script-src 'nonce-n='");
    }
  });

  it("dotted app paths and /dev paths outside the catalog are documents too", () => {
    for (const p of ["/chat/x.y", "/agents/a.b", "/foo.bar", "/login.", "/a/b.png", "/dev/x"]) {
      expect(proxied(p), p).toBe(true);
    }
    for (const p of ["/icon.svg", "/dev/ui", "/dev/ui/display/table", "/_next/static/x.js"]) {
      expect(proxied(p), p).toBe(false);
    }
  });

  it("currentNonce reads the proxy's nonce for the layouts", async () => {
    const { currentNonce } = await import("../src/lib/server/page");
    server.req = new Headers({ [NONCE_HEADER]: "bm9uY2U=" });
    expect(await currentNonce()).toBe("bm9uY2U=");
    server.req = new Headers();
    expect(await currentNonce()).toBe("");
  });
});

describe("the CSPs the document policy leaves alone", () => {
  let upstream: Server;
  let upstreamHeaders: Record<string, string> = {};
  const seen: IncomingMessage[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push(req);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...upstreamHeaders });
      res.end("<!doctype html><p>ok</p>");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    process.env.CAPYBARA_KERNEL_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.CAPYBARA_KERNEL_URL;
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(() => {
    upstreamHeaders = {};
    // the route handlers talk to the fake kernel over the real network
    vi.unstubAllGlobals();
  });

  it("the /plugin-ui and object-store CSPs are untouched", async () => {
    // the proxy never sees /plugin-ui, so the route's own embed CSP is the only one
    expect(proxied("/plugin-ui/fake-embed/panel")).toBe(false);
    const embed = await (pluginUiRoute.GET as (req: Request) => Promise<Response>)(
      new Request(`${WEB}/plugin-ui/fake-embed/panel?token=t`),
    );
    expect(embed.headers.get("content-security-policy")).toBe(EMBED_CSP);

    // server.mjs answers object-store paths before Next: its `sandbox` CSP is all they get
    const cfg = parseObjectStoreProxy({
      CAPYBARA_WEB_OBJECT_STORE_URL: process.env.CAPYBARA_KERNEL_URL,
      CAPYBARA_WEB_OBJECT_STORE_BUCKET: "capybara",
      CAPYBARA_WEB_OBJECT_STORE_PUBLIC_HOST: "web.example",
    });
    if (cfg === undefined) throw new Error("object-store proxy config");
    expect(isObjectStorePath(cfg, "/capybara/kernel/o1/a.png")).toBe(true);
    const web = createServer((req, res) => proxyObjectStore(cfg, req, res));
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    try {
      upstreamHeaders = { "content-security-policy": "script-src 'self' 'nonce-x'" };
      const headers = await new Promise<IncomingMessage["headers"]>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: (web.address() as AddressInfo).port,
            path: "/capybara/kernel/o1/a.png",
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.headers));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(headers["content-security-policy"]).toBe("sandbox");
    } finally {
      web.closeAllConnections();
      await new Promise<void>((r) => web.close(() => r()));
    }

    // nor do Next's static files
    expect(proxied("/_next/static/chunks/main.js")).toBe(false);
  });

  it("/api responses carry no document CSP", async () => {
    expect(proxied("/api/v1/me")).toBe(false);
    expect(proxied("/api")).toBe(false);
    const res = await (apiRoute.GET as (req: Request) => Promise<Response>)(
      new Request(`${WEB}/api/v1/me`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
    // and the documents do go through it
    expect(proxied("/")).toBe(true);
    expect(proxied("/chat/c1")).toBe(true);
    expect(proxied("/admin")).toBe(true);
  });
});
