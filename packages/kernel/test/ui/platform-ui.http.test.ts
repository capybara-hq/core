import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { EmbedTokens } from "../../src/ui/embed-token.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
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
import { openSse, type SseClient, uiFrames } from "../helpers/sse.js";

/**
 * The platform scope of extension UI (UI slots spec §7): org-less routes under
 * `/api/v1/admin/ui/` serve `platform.page` contributions to super admins only (no org
 * enablement, the platform's deployment config); platform embed tokens verify only for a
 * `platform.page` contribution and an account that is still an active super admin; an org token
 * never verifies for a platform page; `ctx.ui.invalidate` without `orgId` for a platform page
 * reaches the platform refresh stream only.
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

let orgId: string;
let owner: Req;
let member: Req;
let root: Req;
let rootCookie: () => string;
let ownerCookie: () => string;
const ids: Record<string, string> = {};

const ADMIN_UI = "/api/v1/admin/ui";
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

/** The render args the ui-slots fixture echoes in its heading (`<id> <args JSON>`). */
const renderArgs = (r: { json(): unknown }, id: string): Record<string, unknown> => {
  const text = (r.json() as { view: { blocks: { text: string }[] } }).view.blocks[0]?.text ?? "";
  expect(text.startsWith(`${id} `)).toBe(true);
  return JSON.parse(text.slice(id.length + 1)) as Record<string, unknown>;
};

/** Verifies a token through the fixture's data route (200 with the claims, or 401). */
const verify = (token: string) =>
  k.http.inject({
    method: "GET",
    url: `/plugins/ui-slots/ui/platform-data?token=${encodeURIComponent(token)}`,
  });

/** Calls `ctx.ui.invalidate` through the fixture's route. */
const invalidate = (target: Record<string, unknown>) =>
  k.http.inject({
    method: "POST",
    url: "/plugins/ui-slots/invalidate",
    headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
    payload: JSON.stringify(target),
  });

const loggedIn = async (login: string): Promise<{ req: Req; cookie: () => string }> => {
  const jar = cookieJar();
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return { req, cookie: () => jar.header() as string };
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel(
    { ...base, extensions: [...base.extensions, fixture("ui-slots")] },
    { env: {} },
  );
  const accounts = accountsFor(db);
  for (const login of ["owner", "member"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  ids.root = (
    await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true })
  ).id;
  const o = await loggedIn("owner");
  owner = o.req;
  ownerCookie = o.cookie;
  member = await session(k, "member");
  const r = await loggedIn("root");
  root = r.req;
  rootCookie = r.cookie;
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, ids.member as string, "member", ids.owner as string);
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const setSuperAdmin = (accountId: string, on: boolean) =>
  sql`UPDATE capybara.accounts SET is_super_admin = ${on} WHERE id = ${accountId}`.execute(raw);

describe("platform UI routes", () => {
  it("a platform page renders while no org has the extension on", async () => {
    const enabled = await sql<{ n: number }>`SELECT count(*)::int AS n
      FROM capybara.extension_org_configs WHERE plugin = 'ui-slots' AND enabled`.execute(raw);
    expect(enabled.rows[0]?.n).toBe(0);
    const r = await root({ method: "GET", url: `${ADMIN_UI}/views/ui-slots/platform-home` });
    expect(r.statusCode, r.body).toBe(200);
    const a = await root({
      method: "POST",
      url: `${ADMIN_UI}/actions/ui-slots/platform-home`,
      payload: { actionId: "go" },
    });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toEqual({ toast: { zh: "好", en: "OK" } });
  });

  it("a super admin lists and renders platform pages without an org", async () => {
    const list = await root({ method: "GET", url: `${ADMIN_UI}/contributions` });
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json() as { items: { plugin: string; id: string; slot: string }[] }).items;
    expect(items.map((i) => `${i.plugin}/${i.id}`)).toEqual([
      "ui-slots/platform-home",
      "ui-slots/platform-embed",
    ]);
    for (const i of items) expect(i.slot).toBe("platform.page");
    const r = await root({
      method: "GET",
      url: `${ADMIN_UI}/views/ui-slots/platform-home?locale=zh`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const args = renderArgs(r, "platform-home");
    expect(args).toMatchObject({
      scope: "platform",
      role: "superAdmin",
      slot: "platform.page",
      accountId: ids.root,
      locale: "zh",
    });
    expect(args).not.toHaveProperty("orgId");
    expect(args).not.toHaveProperty("conversationId");
    expect(args).not.toHaveProperty("agentId");
  });

  it("a non-super-admin gets forbidden on every admin UI route", async () => {
    for (const req of [owner, member]) {
      for (const r of [
        await req({ method: "GET", url: `${ADMIN_UI}/contributions` }),
        await req({ method: "GET", url: `${ADMIN_UI}/views/ui-slots/platform-home` }),
        await req({
          method: "POST",
          url: `${ADMIN_UI}/actions/ui-slots/platform-home`,
          payload: { actionId: "go" },
        }),
        await req({ method: "POST", url: `${ADMIN_UI}/embeds/ui-slots/platform-embed/token` }),
        await req({ method: "GET", url: `${ADMIN_UI}/stream` }),
      ]) {
        expect(r.statusCode, r.body).toBe(403);
        expect(errCode(r)).toBe("forbidden");
      }
    }
  });

  it("an org contribution through the admin routes is 404", async () => {
    for (const r of [
      await root({ method: "GET", url: `${ADMIN_UI}/views/ui-slots/page` }),
      await root({
        method: "POST",
        url: `${ADMIN_UI}/actions/ui-slots/page`,
        payload: { actionId: "go" },
      }),
      await root({ method: "POST", url: `${ADMIN_UI}/embeds/ui-slots/page-embed/token` }),
      await root({ method: "GET", url: `${ADMIN_UI}/views/ui-slots/nope` }),
    ]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(errCode(r)).toBe("ui.not_found");
    }
  });

  it("a platform embed token verifies only for a platform page and a super admin", async () => {
    const t = await root({
      method: "POST",
      url: `${ADMIN_UI}/embeds/ui-slots/platform-embed/token`,
    });
    expect(t.statusCode, t.body).toBe(200);
    const body = t.json() as { token: string; src: string; expiresIn: number };
    expect(body.src).toBe("/plugin-ui/ui-slots/platform");
    expect(body.expiresIn).toBe(300);
    const ok = await verify(body.token);
    expect(ok.statusCode, ok.body).toBe(200);
    const claims = ok.json() as Record<string, unknown>;
    expect(claims).toMatchObject({
      plugin: "ui-slots",
      scope: "platform",
      role: "superAdmin",
      accountId: ids.root,
      contribution: "platform-embed",
    });
    expect(claims).not.toHaveProperty("orgId");

    // the same claims re-signed for an org contribution: null
    const tokens = k.app.get(EmbedTokens);
    const { exp: _exp, ...rest } = claims as Parameters<EmbedTokens["issue"]>[0] & { exp: number };
    const forged = tokens.issue({ ...rest, contribution: "page-embed" }).token;
    expect((await verify(forged)).statusCode).toBe(401);

    // no longer a super admin: null
    await setSuperAdmin(ids.root as string, false);
    try {
      expect((await verify(body.token)).statusCode).toBe(401);
    } finally {
      await setSuperAdmin(ids.root as string, true);
    }
    expect((await verify(body.token)).statusCode).toBe(200);
  });

  it("an org token never verifies for a platform page", async () => {
    await enableExtensions(raw, orgId, "ui-slots");
    try {
      const tokens = k.app.get(EmbedTokens);
      const org = {
        plugin: "ui-slots",
        scope: "org" as const,
        orgId,
        accountId: ids.owner as string,
        role: "owner" as const,
      };
      // baseline: the org.page embed verifies
      const page = tokens.issue({ ...org, contribution: "page-embed" }).token;
      expect((await verify(page)).statusCode).toBe(200);
      const forged = tokens.issue({ ...org, contribution: "platform-embed" }).token;
      expect((await verify(forged)).statusCode).toBe(401);
    } finally {
      await sql`DELETE FROM capybara.extension_org_configs WHERE plugin = 'ui-slots'`.execute(raw);
    }
  });

  it("invalidate without orgId reaches the platform stream only", async () => {
    await enableExtensions(raw, orgId, "ui-slots");
    const streams: SseClient[] = [];
    try {
      const platform = await openSse(`http://127.0.0.1:${k.port}${ADMIN_UI}/stream`, {
        cookie: rootCookie(),
      });
      streams.push(platform);
      expect(platform.status).toBe(200);
      expect(platform.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const org = await openSse(`http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/ui/stream`, {
        cookie: ownerCookie(),
      });
      streams.push(org);
      expect(org.status).toBe(200);

      const inv = await invalidate({ contribution: "platform-home" });
      expect(inv.statusCode, inv.body).toBe(204);
      await platform.until(
        (m) => uiFrames(m).some((f) => f.contribution === "platform-home"),
        10_000,
        "platform ui frame",
      );
      // an org refresh published after it reaches the org stream; the platform one never did
      const orgInv = await invalidate({ orgId, contribution: "page" });
      expect(orgInv.statusCode, orgInv.body).toBe(204);
      await org.until(
        (m) => uiFrames(m).some((f) => f.contribution === "page"),
        10_000,
        "org ui frame",
      );
      expect(uiFrames(org.messages).map((f) => f.contribution)).toEqual(["page"]);
      expect(uiFrames(platform.messages)).toEqual([
        { plugin: "ui-slots", contribution: "platform-home" },
      ]);
    } finally {
      for (const s of streams) s.close();
      await sql`DELETE FROM capybara.extension_org_configs WHERE plugin = 'ui-slots'`.execute(raw);
    }
  });

  it("invalidate with orgId for a platform page throws", async () => {
    const r = await invalidate({ orgId, contribution: "platform-home" });
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe(
      "plugin ui-slots: ui.invalidate: platform-home is a platform page; omit orgId",
    );
    // and no orgId for an org contribution throws as before
    const o = await invalidate({ contribution: "page" });
    expect(o.statusCode).toBe(400);
    expect(o.body).toMatch(/needs a non-empty orgId/);
  });
});
