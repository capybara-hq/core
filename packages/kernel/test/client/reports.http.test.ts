import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, enableExtensions, PW } from "../helpers/runs.js";
import { clientPlugin, importClientPlugin, type Person, sha256, signIn } from "./client-env.js";

/**
 * Client crash reports (client extensions spec §10.4, plan Task 11): `POST /api/v1/orgs/:orgId/ui/
 * client/reports` and `POST /api/v1/admin/ui/client/reports` upsert one row per (plugin, build,
 * org, contribution, kind) for a build the reporter could fetch; 204, 404 `client.not_found`
 * otherwise, 400 for a message over 500 characters, 429 after 20 a minute per account. The admin
 * extension detail lists the current build's files and its reports.
 */

let env: OrgEnv;
let orgB: string;
let mem: Person;
let bmem: Person;
let flood: Person;
let guest: Person;
let racer: Person;
let sa: Person;
let pageSha: string;
let plainSha: string;

const PAGE = "cx-page";
const PLAIN = "cx-plain";

beforeAll(async () => {
  env = await startOrgEnv();
  orgB = await createOrg(env.root, "B");
  const accounts = accountsFor(env.db);
  const bmemId = (await accounts.createLocal({ login: "bmem", password: PW, displayName: "BM" }))
    .id;
  const floodId = (await accounts.createLocal({ login: "flood", password: PW, displayName: "F" }))
    .id;
  const guestId = (await accounts.createLocal({ login: "guest", password: PW, displayName: "G" }))
    .id;
  const racerId = (await accounts.createLocal({ login: "racer", password: PW, displayName: "R" }))
    .id;
  await accounts.createLocal({
    login: "nomember",
    password: PW,
    displayName: "S",
    superAdmin: true,
  });
  await env.db
    .insertInto("memberships")
    .values([
      { org_id: orgB, account_id: bmemId, role: "member" },
      { org_id: env.orgId, account_id: floodId, role: "member" },
      { org_id: env.orgId, account_id: guestId, role: "guest" },
      { org_id: env.orgId, account_id: racerId, role: "member" },
    ])
    .execute();
  mem = await signIn(env, "mem");
  bmem = await signIn(env, "bmem");
  flood = await signIn(env, "flood");
  guest = await signIn(env, "guest");
  racer = await signIn(env, "racer");
  sa = await signIn(env, "nomember");
  const page = await clientPlugin({
    name: PAGE,
    components: [
      { id: "page", slot: "platform.page" },
      { id: "hud", slot: "conversation.properties.section" },
    ],
    decorated: true,
  });
  const plain = await clientPlugin({
    name: PLAIN,
    components: [{ id: "hud", slot: "conversation.properties.section" }],
  });
  pageSha = sha256(page);
  plainSha = sha256(plain);
  await importClientPlugin(env, page, PAGE);
  await importClientPlugin(env, plain, PLAIN);
  await enableExtensions(env.db, env.orgId, PAGE, PLAIN);
});

afterAll(async () => {
  await env?.stop();
});

const body = (o: Record<string, unknown> = {}) => ({
  plugin: PLAIN,
  build: plainSha,
  contribution: "hud",
  kind: "render",
  message: "boom",
  ...o,
});
const post = (p: Person, orgId: string, b: unknown) =>
  p.req({ method: "POST", url: `/api/v1/orgs/${orgId}/ui/client/reports`, payload: b as object });
const rows = () =>
  env.db.selectFrom("extension_client_reports").selectAll().orderBy("last_at", "desc").execute();

describe("client reports", () => {
  it("a report upserts one row and counts", async () => {
    const first = await post(mem, env.orgId, body({ message: "first" }));
    expect(first.statusCode, first.body).toBe(204);
    const second = await post(mem, env.orgId, body({ message: "second" }));
    expect(second.statusCode, second.body).toBe(204);
    const mine = (await rows()).filter((r) => r.plugin === PLAIN);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      build: plainSha,
      org_id: env.orgId,
      contribution: "hud",
      kind: "render",
      count: 2,
      last_message: "second",
    });
    // another kind or a null contribution is another row
    await post(mem, env.orgId, body({ kind: "load", contribution: null }));
    expect((await rows()).filter((r) => r.plugin === PLAIN)).toHaveLength(2);
  });

  it("a report for a plugin not on in the org is 404", async () => {
    // PLAIN is on in org A only; bmem is a member of org B
    const r = await post(bmem, orgB, body());
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.code).toBe("client.not_found");
    // a build the reporter cannot fetch (wrong build id) is the same answer
    const wrong = await post(mem, env.orgId, body({ build: "0".repeat(64) }));
    expect(wrong.statusCode).toBe(404);
    expect((await rows()).some((x) => x.org_id === orgB)).toBe(false);
  });

  it("a contribution must be a component of the build", async () => {
    const before = (await rows()).length;
    // well formed but not a component of the build: the same 404 as an unknown build
    for (const contribution of ["page", "made-up", "hud2"]) {
      const r = await post(mem, env.orgId, body({ contribution }));
      expect(r.statusCode, contribution).toBe(404);
      expect(r.json().error.code, contribution).toBe("client.not_found");
    }
    // not the component id grammar at all
    for (const contribution of ["", "Hud", "plain/hud", "x".repeat(41), "1hud"]) {
      const r = await post(mem, env.orgId, body({ contribution }));
      expect(r.statusCode, contribution).toBe(400);
    }
    expect((await rows()).length).toBe(before);
  });

  it("a guest of the org may report", async () => {
    const r = await post(guest, env.orgId, body({ kind: "event", message: "from a guest" }));
    expect(r.statusCode, r.body).toBe(204);
    expect((await rows()).find((x) => x.last_message === "from a guest")).toMatchObject({
      org_id: env.orgId,
      contribution: "hud",
      kind: "event",
    });
  });

  it("two reports of one key at once are one row counted twice", async () => {
    const key = body({ kind: "api", contribution: null, message: "race" });
    const [a, b] = await Promise.all([post(racer, env.orgId, key), post(racer, env.orgId, key)]);
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
    const raced = (await rows()).filter(
      (r) => r.plugin === PLAIN && r.kind === "api" && r.contribution === null,
    );
    expect(raced).toHaveLength(1);
    expect(raced[0]?.count).toBe(2);
  });

  it("a message over 500 characters is 400", async () => {
    const ok = await post(mem, env.orgId, body({ message: "x".repeat(500) }));
    expect(ok.statusCode, ok.body).toBe(204);
    const r = await post(mem, env.orgId, body({ message: "x".repeat(501) }));
    expect(r.statusCode).toBe(400);
    const kind = await post(mem, env.orgId, body({ kind: "nope" }));
    expect(kind.statusCode).toBe(400);
  });

  it("an admin report has no org and needs a platform page build", async () => {
    const admin = (b: unknown) =>
      sa.req({ method: "POST", url: "/api/v1/admin/ui/client/reports", payload: b as object });
    const ok = await admin(body({ plugin: PAGE, build: pageSha, contribution: "page" }));
    expect(ok.statusCode, ok.body).toBe(204);
    const row = (await rows()).find((r) => r.plugin === PAGE);
    expect(row).toMatchObject({ org_id: null, contribution: "page", count: 1 });
    // no platform.page component: not fetchable by the admin console
    const no = await admin(body());
    expect(no.statusCode).toBe(404);
    // not a super admin
    const denied = await mem.req({
      method: "POST",
      url: "/api/v1/admin/ui/client/reports",
      payload: body({ plugin: PAGE, build: pageSha }),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("the 21st report in a minute is 429", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await post(flood, env.orgId, body());
      expect(r.statusCode, `${i}: ${r.body}`).toBe(204);
    }
    const r = await post(flood, env.orgId, body());
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
  });

  it("the admin detail lists the build and its reports", async () => {
    const r = await env.root({ method: "GET", url: `/api/v1/admin/extensions/${PAGE}` });
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    expect(v.client.build).toBe(pageSha);
    expect(v.client.apiVersion).toBe(1);
    const paths = v.client.files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "./dist/client/client.mjs",
        "./dist/client/styles/a.css",
        "./dist/client/assets/logo.svg",
      ]),
    );
    for (const f of v.client.files) expect(f.bytes).toBeGreaterThan(0);
    expect(v.clientReports).toEqual([
      expect.objectContaining({
        orgId: null,
        contribution: "page",
        kind: "render",
        count: 1,
        lastMessage: "boom",
      }),
    ]);
    const plain = (
      await env.root({ method: "GET", url: `/api/v1/admin/extensions/${PLAIN}` })
    ).json();
    expect(plain.clientReports.length).toBeGreaterThanOrEqual(2);
    expect(plain.clientReports[0].lastAt >= plain.clientReports[1].lastAt).toBe(true);
  });

  it("the admin view lists the newest 50 reports of the build", async () => {
    // 60 rows, one per made-up org so the key keeps them apart; the newest is n59
    const at = Date.now() + 3_600_000;
    await env.db
      .insertInto("extension_client_reports")
      .values(
        Array.from({ length: 60 }, (_, n) => ({
          plugin: PLAIN,
          build: plainSha,
          org_id: crypto.randomUUID(),
          contribution: null,
          kind: "load" as const,
          last_message: `n${n}`,
          first_at: new Date(at + n * 1000),
          last_at: new Date(at + n * 1000),
        })),
      )
      .execute();
    const v = (await env.root({ method: "GET", url: `/api/v1/admin/extensions/${PLAIN}` })).json();
    expect(v.clientReports).toHaveLength(50);
    expect(v.clientReports[0].lastMessage).toBe("n59");
    expect(v.clientReports[49].lastMessage).toBe("n10");
    const list = (await env.root({ method: "GET", url: "/api/v1/admin/extensions" })).json();
    const item = list.extensions.find((x: { name: string }) => x.name === PLAIN);
    expect(item.clientReports).toHaveLength(50);
  });
});
