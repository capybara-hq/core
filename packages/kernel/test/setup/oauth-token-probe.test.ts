import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type FakeOAuthServer, startFakeOAuthServer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetPolicy } from "../../src/net/public-address.js";
import {
  PROBE_CODE,
  PROBE_TEXTS,
  probeTokenEndpoint,
  redirectFix,
} from "../../src/setup/oauth-token-probe.js";
import type { OAuthClientRecord } from "../../src/tools/oauth/tokens.js";

// The token endpoint probe of `capybara:oauth-token-endpoint` (spec
// 2026-11-09-setup-guides-v2-design.md §10.6, plan T11 requirement 3): one code exchange with a
// fixed invalid code, mapped by the OAuth flow's refusal parser to fixed texts; no redirects, the
// run's signal, a 2xx token never kept.

const SECRET = "probe-client-secret-6c1f0a93e2";
const CLIENT = "probe-client";
const CALLBACK = "https://capybara.example.com/api/v1/oauth/callback";
const NET: NetPolicy = { allowInsecureLoopback: true, allowPrivateHosts: [], trustedOrigins: [] };

let oauth: FakeOAuthServer;
let slack: FakeOAuthServer;

beforeAll(async () => {
  oauth = await startFakeOAuthServer({ clients: [{ clientId: CLIENT, clientSecret: SECRET }] });
  slack = await startFakeOAuthServer({
    dialect: "slack",
    clients: [{ clientId: CLIENT, clientSecret: SECRET }],
  });
});

afterAll(async () => {
  await oauth?.stop();
  await slack?.stop();
});

const client = (
  server: { issuer: string },
  over: Partial<OAuthClientRecord> = {},
): OAuthClientRecord => ({
  clientId: CLIENT,
  clientSecret: SECRET,
  authMethod: "client_secret_basic",
  tokenEndpoint: `${server.issuer}/token`,
  ...over,
});

const probe = (c: OAuthClientRecord, signal = AbortSignal.timeout(5_000)) =>
  probeTokenEndpoint({ client: c, redirectUri: CALLBACK, net: NET, signal });

/** Every text of a result, for "no secret, no server text" assertions. */
const texts = (r: unknown) => JSON.stringify(r);

/** A local server answering the token endpoint with one fixed response. */
async function fixedServer(
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<{ url: string; requests: number; stop(): Promise<void> }> {
  const s = { requests: 0 };
  const http = createServer((_req, res) => {
    s.requests++;
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/token`,
    get requests() {
      return s.requests;
    },
    stop: () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}

describe("the token endpoint probe", { timeout: 30_000 }, () => {
  it("invalid_grant: the client authenticated, the code was bad → ok (Basic and post)", async () => {
    for (const authMethod of ["client_secret_basic", "client_secret_post"] as const) {
      const before = oauth.tokenRequests.length;
      const r = await probe(client(oauth, { authMethod }));
      expect(r).toEqual({ status: "ok", reason: PROBE_TEXTS.accepted });
      const req = oauth.tokenRequests[before];
      expect(req).toMatchObject({
        grantType: "authorization_code",
        clientId: CLIENT,
        clientAuth: authMethod === "client_secret_basic" ? "basic" : "post",
        error: "invalid_grant",
      });
      expect(oauth.tokenRequests).toHaveLength(before + 1);
    }
  });

  it("Slack dialect: invalid_code → ok; invalid_client_id → failing with the copy-again fix", async () => {
    expect(await probe(client(slack))).toEqual({ status: "ok", reason: PROBE_TEXTS.accepted });
    expect(slack.tokenRequests.at(-1)?.error).toBe("invalid_code");
    const r = await probe(client(slack, { clientSecret: "wrong-secret-0123456789" }));
    expect(r).toEqual({
      status: "failing",
      reason: PROBE_TEXTS.clientRefused,
      fix: PROBE_TEXTS.clientFix,
    });
    expect(slack.tokenRequests.at(-1)?.error).toBe("invalid_client_id");
  });

  it("a refused client (invalid_client, unauthorized_client, bad_client_secret, bare 401) → failing", async () => {
    // a wrong secret on an RFC 6749 server: 401 invalid_client
    expect(await probe(client(oauth, { clientSecret: "wrong-secret-0123456789" }))).toEqual({
      status: "failing",
      reason: PROBE_TEXTS.clientRefused,
      fix: PROBE_TEXTS.clientFix,
    });
    const cases: [number, unknown][] = [
      [400, { error: "unauthorized_client" }],
      [200, { ok: false, error: "bad_client_secret" }],
      [401, { message: "who are you" }],
      [401, "not json"],
    ];
    for (const [status, body] of cases) {
      oauth.failTokenRequests(1, status, body);
      const r = await probe(client(oauth));
      expect(r.status, JSON.stringify(body)).toBe("failing");
      expect(r.fix).toEqual(PROBE_TEXTS.clientFix);
    }
  });

  it("redirect_uri_mismatch / bad_redirect_uri → failing with the kernel's callback URL only", async () => {
    for (const [status, body] of [
      [400, { error: "redirect_uri_mismatch", error_description: "evil https://x.example" }],
      [200, { ok: false, error: "bad_redirect_uri" }],
    ] as const) {
      oauth.failTokenRequests(1, status, body);
      const r = await probe(client(oauth));
      expect(r).toEqual({
        status: "failing",
        reason: PROBE_TEXTS.redirectRefused,
        fix: redirectFix(CALLBACK),
      });
      expect(texts(r)).not.toContain("x.example");
    }
    expect(redirectFix(CALLBACK).en).toContain(CALLBACK);
  });

  it("429, 5xx, other codes, transient codes → unknown with the fixed text", async () => {
    const cases: [number, unknown][] = [
      [429, { error: "slow_down" }],
      [500, { error: "server_error" }],
      [503, "down"],
      [400, { error: "invalid_request", error_description: "secret is x" }],
      [200, { ok: false, error: "ratelimited" }],
      [403, { error: "invalid_client" }],
    ];
    for (const [status, body] of cases) {
      oauth.failTokenRequests(1, status, body);
      const r = await probe(client(oauth));
      expect(r, JSON.stringify(body)).toEqual({ status: "unknown", reason: PROBE_TEXTS.unknown });
    }
  });

  it("a 2xx with a token → unknown; the token is in no result", async () => {
    const token = "at_issued_by_mistake_0123456789";
    oauth.failTokenRequests(1, 200, {
      access_token: token,
      token_type: "Bearer",
      refresh_token: "rt_issued_by_mistake_0123",
    });
    const r = await probe(client(oauth));
    expect(r).toEqual({ status: "unknown", reason: PROBE_TEXTS.unknown });
    expect(texts(r)).not.toContain(token);
  });

  it("a network error → unknown; a refused address → unknown with the network rules text", async () => {
    const dead = await fixedServer(200, "{}");
    const url = dead.url;
    await dead.stop();
    expect(await probe(client(oauth, { tokenEndpoint: url }))).toEqual({
      status: "unknown",
      reason: PROBE_TEXTS.unknown,
    });
    // loopback without allowInsecureLoopback: refused by the network rules, nothing sent
    const before = oauth.tokenRequests.length;
    const r = await probeTokenEndpoint({
      client: client(oauth),
      redirectUri: CALLBACK,
      net: { ...NET, allowInsecureLoopback: false },
      signal: AbortSignal.timeout(5_000),
    });
    expect(r.status).toBe("unknown");
    expect(oauth.tokenRequests).toHaveLength(before);
  });

  it("no redirects followed: a 302 → unknown, its target never called", async () => {
    const target = await fixedServer(400, JSON.stringify({ error: "invalid_grant" }));
    const redirecting = await fixedServer(302, "", { location: target.url });
    try {
      const r = await probe(client(oauth, { tokenEndpoint: redirecting.url }));
      expect(r).toEqual({ status: "unknown", reason: PROBE_TEXTS.unknown });
      expect(redirecting.requests).toBe(1);
      expect(target.requests).toBe(0);
    } finally {
      await target.stop();
      await redirecting.stop();
    }
  });

  it("honors the run's signal: a hanging endpoint answers unknown at the abort", async () => {
    const hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const { port } = hang.address() as AddressInfo;
    try {
      const started = Date.now();
      const r = await probe(
        client(oauth, { tokenEndpoint: `http://127.0.0.1:${port}/token` }),
        AbortSignal.timeout(200),
      );
      expect(r.status).toBe("unknown");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it("sends the fixed code and the callback URL; the secret only in the Authorization header", async () => {
    let seen: { auth: string | undefined; body: string } = { auth: undefined, body: "" };
    const http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen = { auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const { port } = http.address() as AddressInfo;
    try {
      await probe(client(oauth, { tokenEndpoint: `http://127.0.0.1:${port}/token` }));
      const form = new URLSearchParams(seen.body);
      expect(form.get("code")).toBe(PROBE_CODE);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("redirect_uri")).toBe(CALLBACK);
      expect(seen.body).not.toContain(SECRET);
      expect(seen.auth).toBe(`Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
