import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PLUGIN_PUBLIC_WRITE_LIMIT } from "../../src/http/plugin-route-access.js";
import { createLogger } from "../../src/log.js";
import { routeAccessCalls } from "../fixtures/plugins/route-access/index.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Extension route access (spec 2026-11-15-extension-route-auth): the kernel resolves the caller of
 * every extension route from its declared access before the body is read and before the handler
 * runs, and the handler never sees kernel credentials. One kernel with the `route-access` fixture
 * (one route per level; `baseUrl` is a required overridable field the platform leaves empty, so an
 * org without its own copy needs configuration). The public write limit is lowered to 3 through
 * the `PLUGIN_PUBLIC_WRITE_LIMIT` seam. `route-access-other` only issues embed tokens of another
 * extension.
 */

const ROUTE_ACCESS = fileURLToPath(
  new URL("../fixtures/plugins/route-access/index.ts", import.meta.url),
);
const OTHER = fileURLToPath(
  new URL("../fixtures/plugins/route-access-other/index.ts", import.meta.url),
);
const LIMIT = 3;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel(
    { ...base, extensions: [...base.extensions, ROUTE_ACCESS, OTHER] },
    {
      env: {},
      logger: createLogger("error", { write: () => {} }),
      overrides: [{ provide: PLUGIN_PUBLIC_WRITE_LIMIT, useValue: LIMIT }],
    },
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Body = { caller: Record<string, unknown>; auth: string | null; cookie: string | null };
type Inject = Parameters<TestKernel["http"]["inject"]>[0];

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

const call = (o: {
  method?: "GET" | "POST" | "HEAD" | "PUT";
  url: string;
  token?: string;
  headers?: Record<string, string>;
  payload?: string | Buffer;
  remoteAddress?: string;
}) =>
  k.http.inject({
    method: o.method ?? "GET",
    url: o.url,
    headers: {
      ...(o.token !== undefined && { authorization: `Bearer ${o.token}` }),
      ...o.headers,
    },
    ...(o.payload !== undefined && { payload: o.payload }),
    ...(o.remoteAddress !== undefined && { remoteAddress: o.remoteAddress }),
  } as Inject);

let seq = 0;
async function person(role: "owner" | "admin" | "member" | "guest" | "none", orgId: string) {
  const login = `${role}${++seq}`;
  const id = (await accountsFor(db).createLocal({ login, password: PW, displayName: login })).id;
  if (role !== "none" && role !== "owner") {
    await testMembers(db).add(orgId, id, role, ownerId);
  }
  const { token } = await apiTokensFor(db).createPersonal(id, { name: "t" });
  return { id, token };
}

let ownerId: string;
let ownerPat: string;
let owner: Req;
let orgA: string;
let orgB: string;
let orgOff: string;

const items = (orgId: string) => `/plugins/route-access/orgs/${orgId}/items`;
const settings = (orgId: string) => `/plugins/route-access/orgs/${orgId}/settings`;

beforeEach(async () => {
  routeAccessCalls().length = 0;
});

beforeAll(async () => {
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "owner" })
  ).id;
  ownerPat = (await apiTokensFor(db).createPersonal(ownerId, { name: "t" })).token;
  owner = await session(k, "owner");
  orgA = await createOrg(owner, "A");
  orgB = await createOrg(owner, "B");
  orgOff = await createOrg(owner, "Off");
  await enableExtensions(raw, orgA, "route-access", "route-access-other");
  await enableExtensions(raw, orgB, "route-access");
  // org A keeps its own copy of the required overridable field; org B follows the empty platform
  const copy = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgA}/extensions/route-access/overrides`,
    payload: { values: { baseUrl: "https://org-a.test" } },
  });
  expect(copy.statusCode, copy.body).toBe(200);
});

describe("public routes", () => {
  it("anyone calls them; the caller is { access: public }", async () => {
    const r = await call({ url: "/plugins/route-access/ping" });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as Body).caller).toEqual({ access: "public" });
  });

  it("kernel tokens are stripped before the handler; other authorization stays", async () => {
    for (const token of [ownerPat, "cap_svc_whatever"]) {
      const r = await call({ url: "/plugins/route-access/ping", token });
      expect((r.json() as Body).auth, token).toBeNull();
    }
    const sig = await call({
      url: "/plugins/route-access/ping",
      headers: { authorization: "Signature abc" },
    });
    expect((sig.json() as Body).auth).toBe("Signature abc");
  });

  it("unsafe methods are limited per client IP; reads are not", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < LIMIT; i++) {
      const ok = await call({
        method: "POST",
        url: "/plugins/route-access/hook",
        remoteAddress: ip,
      });
      expect(ok.statusCode, ok.body).toBe(200);
    }
    const over = await call({
      method: "POST",
      url: "/plugins/route-access/hook",
      remoteAddress: ip,
    });
    expect(over.statusCode).toBe(429);
    expect(errCode(over)).toBe("rate_limited");
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    // another address has its own count; a GET is never limited
    const other = await call({
      method: "POST",
      url: "/plugins/route-access/hook",
      remoteAddress: "198.51.100.8",
    });
    expect(other.statusCode).toBe(200);
    for (let i = 0; i <= LIMIT; i++) {
      const get = await call({ url: "/plugins/route-access/ping", remoteAddress: ip });
      expect(get.statusCode).toBe(200);
    }
    expect(routeAccessCalls().filter((c) => c === "POST /hook")).toHaveLength(LIMIT + 1);
  });
});

describe("member and admin routes", () => {
  it("an owner's personal token: 200 with the org, account, role and effective config", async () => {
    const r = await call({ url: items(orgA), token: ownerPat });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as Body;
    expect(body.caller).toEqual({
      access: "member",
      orgId: orgA,
      accountId: ownerId,
      role: "owner",
      config: { baseUrl: "https://org-a.test" },
    });
    // the handler never sees the personal token
    expect(body.auth).toBeNull();
  });

  it("a session cookie never authenticates: 401 auth.required", async () => {
    const r = await owner({ method: "GET", url: items(orgA) });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("no token or an unknown one: 401; a service token: 403 forbidden", async () => {
    for (const token of [undefined, "cap_pat_nope", "garbage"]) {
      const r = await call({ url: items(orgA), ...(token !== undefined && { token }) });
      expect(r.statusCode, String(token)).toBe(401);
      expect(errCode(r)).toBe("auth.required");
    }
    const { token: svc } = await apiTokensFor(db).createService(orgA, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    const r = await call({ url: items(orgA), token: svc });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe("forbidden");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("a disabled account: auth.account_disabled; one that must change its password: auth.password_change_required", async () => {
    const disabled = await person("member", orgA);
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${disabled.id}`.execute(
      raw,
    );
    const d = await call({ url: items(orgA), token: disabled.token });
    expect(errCode(d)).toBe("auth.account_disabled");
    const pw = await person("member", orgA);
    await sql`UPDATE capybara.accounts SET must_change_password = true WHERE id = ${pw.id}`.execute(
      raw,
    );
    const p = await call({ url: items(orgA), token: pw.token });
    expect(errCode(p)).toBe("auth.password_change_required");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("a non-member, an org where the extension is off, an unknown org: 404 org.not_found", async () => {
    const outsider = await person("none", orgA);
    for (const [token, orgId] of [
      [outsider.token, orgA],
      [ownerPat, orgOff],
      [ownerPat, "no-such-org"],
    ] as const) {
      const r = await call({ url: items(orgId), token });
      expect(r.statusCode, orgId).toBe(404);
      expect(errCode(r)).toBe("org.not_found");
    }
    // a deleted org
    const gone = await createOrg(owner, "Gone");
    await enableExtensions(raw, gone, "route-access");
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${gone}`.execute(raw);
    expect(errCode(await call({ url: items(gone), token: ownerPat }))).toBe("org.not_found");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("a guest on a member route and a member on an admin route: 403; an admin on an admin route: 200", async () => {
    const guest = await person("guest", orgA);
    const g = await call({ url: items(orgA), token: guest.token });
    expect(g.statusCode).toBe(403);
    expect(errCode(g)).toBe("forbidden");
    const member = await person("member", orgA);
    expect((await call({ url: items(orgA), token: member.token })).statusCode).toBe(200);
    const m = await call({ url: settings(orgA), token: member.token });
    expect(m.statusCode).toBe(403);
    expect(errCode(m)).toBe("forbidden");
    const admin = await person("admin", orgA);
    const a = await call({ url: settings(orgA), token: admin.token });
    expect(a.statusCode, a.body).toBe(200);
    expect((a.json() as Body).caller).toMatchObject({
      access: "admin",
      orgId: orgA,
      accountId: admin.id,
      role: "admin",
    });
  });

  it("an org whose effective config is invalid: 409 extension.needs_config", async () => {
    const r = await call({ url: items(orgB), token: ownerPat });
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe("extension.needs_config");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("a 2 MiB body without a token: 401, refused before the body is read (not 413)", async () => {
    const r = await call({
      method: "POST",
      url: items(orgA),
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });

  it("HEAD uses the GET route's access and params", async () => {
    const none = await call({ method: "HEAD", url: items(orgA) });
    expect(none.statusCode).toBe(401);
    const ok = await call({ method: "HEAD", url: items(orgA), token: ownerPat });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("");
    const outsider = await person("none", orgA);
    const hidden = await call({ method: "HEAD", url: items(orgA), token: outsider.token });
    expect(hidden.statusCode).toBe(404);
    expect(routeAccessCalls()).toEqual(["GET /items"]);
  });

  it("the org-less path of a member route is not mounted", async () => {
    const r = await call({ url: "/plugins/route-access/items", token: ownerPat });
    expect(r.statusCode).toBe(404);
    expect(errCode(r)).toBe("not_found");
  });
});

describe("embed routes", () => {
  const issue = async (orgId: string, plugin = "route-access", as: Req = owner) => {
    const r = await as({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/ui/embeds/${plugin}/page/token`,
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { token: string }).token;
  };

  it("the page is a public GET: no token needed", async () => {
    const r = await call({ url: "/plugins/route-access/ui/page" });
    expect(r.statusCode).toBe(200);
    expect((r.json() as Body).caller).toEqual({ access: "public" });
  });

  it("a valid org token as Bearer or ?token=: the caller, and the handler keeps the embed token", async () => {
    const token = await issue(orgA);
    const bearer = await call({ url: "/plugins/route-access/ui/data", token });
    expect(bearer.statusCode, bearer.body).toBe(200);
    const body = bearer.json() as Body;
    expect(body.caller).toMatchObject({
      access: "embed",
      scope: "org",
      orgId: orgA,
      accountId: ownerId,
      role: "owner",
      contribution: "page",
      config: { baseUrl: "https://org-a.test" },
    });
    expect(body.caller).not.toHaveProperty("conversationId");
    expect(typeof body.caller.exp).toBe("number");
    expect(body.caller.exp as number).toBeGreaterThan(Date.now() / 1000);
    expect(body.auth).toBe(`Bearer ${token}`);
    const query = await call({ url: `/plugins/route-access/ui/data?token=${token}` });
    expect(query.statusCode, query.body).toBe(200);
    expect((query.json() as Body).caller).toMatchObject({ access: "embed", orgId: orgA });
  });

  it("no token, a forged one, a personal token: 401 auth.required", async () => {
    const token = await issue(orgA);
    for (const t of [undefined, "garbage", `${token}x`, ownerPat]) {
      const r = await call({
        url: "/plugins/route-access/ui/data",
        ...(t !== undefined && { token: t }),
      });
      expect(r.statusCode, String(t)).toBe(401);
      expect(errCode(r)).toBe("auth.required");
    }
    expect(routeAccessCalls()).toEqual([]);
  });

  it("a token whose account left the org: 401", async () => {
    const member = await person("member", orgA);
    const req = await session(k, `member${seq}`);
    const r0 = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/ui/embeds/route-access/page/token`,
      payload: {},
    });
    expect(r0.statusCode, r0.body).toBe(200);
    const token = (r0.json() as { token: string }).token;
    expect((await call({ url: "/plugins/route-access/ui/data", token })).statusCode).toBe(200);
    await sql`DELETE FROM capybara.memberships WHERE account_id = ${member.id}`.execute(raw);
    const r = await call({ url: "/plugins/route-access/ui/data", token });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });

  it("a token issued for another extension: 401", async () => {
    const token = await issue(orgA, "route-access-other");
    const r = await call({ url: "/plugins/route-access/ui/data", token });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("a token issued before the extension was switched off in the org: 401", async () => {
    const orgD = await createOrg(owner, "D");
    await enableExtensions(raw, orgD, "route-access");
    const copy = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgD}/extensions/route-access/overrides`,
      payload: { values: { baseUrl: "https://org-d.test" } },
    });
    expect(copy.statusCode, copy.body).toBe(200);
    const token = await issue(orgD);
    expect((await call({ url: "/plugins/route-access/ui/data", token })).statusCode).toBe(200);
    await sql`UPDATE capybara.extension_org_configs SET enabled = false
      WHERE plugin = 'route-access' AND org_id = ${orgD}`.execute(raw);
    const r = await call({ url: "/plugins/route-access/ui/data", token });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });

  it("a token whose holder's current role is below the slot's minRole (org.page: member): 401", async () => {
    const member = await person("member", orgA);
    const token = await issue(orgA, "route-access", await session(k, `member${seq}`));
    expect((await call({ url: "/plugins/route-access/ui/data", token })).statusCode).toBe(200);
    await sql`UPDATE capybara.memberships SET role = 'guest'
      WHERE account_id = ${member.id} AND org_id = ${orgA}`.execute(raw);
    const r = await call({ url: "/plugins/route-access/ui/data", token });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });

  it("an org whose effective config turned invalid: 409 extension.needs_config", async () => {
    const orgC = await createOrg(owner, "C");
    await enableExtensions(raw, orgC, "route-access");
    const saved = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgC}/extensions/route-access/overrides`,
      payload: { values: { baseUrl: "https://org-c.test" } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const token = await issue(orgC);
    const reset = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgC}/extensions/route-access/overrides`,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const r = await call({ url: "/plugins/route-access/ui/data", token });
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe("extension.needs_config");
    expect(routeAccessCalls()).toEqual([]);
  });

  it("?token= on a POST with a 2 MiB body and an invalid token: 401 before the body is read", async () => {
    const r = await call({
      method: "POST",
      url: "/plugins/route-access/ui/data?token=garbage",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(r.statusCode).toBe(401);
    expect(errCode(r)).toBe("auth.required");
  });
});
