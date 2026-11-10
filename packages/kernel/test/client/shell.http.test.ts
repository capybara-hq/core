import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, enableExtensions, PW, type Req } from "../helpers/runs.js";
import { clientPlugin, importClientPlugin, setKillSwitch, sha256, signIn } from "./client-env.js";

/**
 * The shell reads of client extensions (client extensions spec §9.2, §9.6, §10.2; plan Task 10):
 * `GET /api/v1/orgs/:orgId/ui/client` lists the extensions enabled in the org that run with an
 * approved client build, with file URLs, integrity and the components the viewer's role may use;
 * `GET /api/v1/admin/ui/client?plugin=` lists only `platform.page` components and no styles (the
 * admin console runs no org client code). Both are `no-store`; the kill switch empties them.
 */

let env: OrgEnv;
let orgB: string;
let guest: Req;
let pageSha: string;
let plainSha: string;

const PAGE = "cx-page";
const PLAIN = "cx-plain";

interface Item {
  plugin: string;
  build: string;
  entry: { url: string; integrity: string } | null;
  styles: { url: string; integrity: string }[];
  components: { id: string; slot: string }[];
  signInId: string;
}
interface Shell {
  enabled: boolean;
  apiVersion: number;
  items: Item[];
}

beforeAll(async () => {
  env = await startOrgEnv();
  orgB = await createOrg(env.root, "B");
  const guestId = (
    await accountsFor(env.db).createLocal({ login: "guest", password: PW, displayName: "G" })
  ).id;
  await env.db
    .insertInto("memberships")
    .values({ org_id: env.orgId, account_id: guestId, role: "guest" })
    .execute();
  guest = (await signIn(env, "guest")).req;
  const page = await clientPlugin({
    name: PAGE,
    components: [
      { id: "page", slot: "platform.page" },
      { id: "hud", slot: "conversation.properties.section" },
      { id: "settings", slot: "org.settings.section" },
      { id: "fx", slot: "shell.overlay" },
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
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await env.db.deleteFrom("deployment_settings").where("key", "=", "clientExtensions").execute();
});

const integrity = async (build: string) =>
  (
    await env.db
      .selectFrom("extension_client_builds")
      .select("integrity")
      .where("package_sha256", "=", build)
      .executeTakeFirstOrThrow()
  ).integrity;

async function orgRead(req: Req, orgId = env.orgId): Promise<Shell> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/ui/client` });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return r.json() as Shell;
}

async function adminRead(query = ""): Promise<Shell> {
  const r = await env.root({ method: "GET", url: `/api/v1/admin/ui/client${query}` });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return r.json() as Shell;
}

/** A sign-in id: 128 bits, base64url. */
const SIGN_IN_ID = expect.stringMatching(/^[A-Za-z0-9_-]{22}$/);

const signInIds = (s: Shell) => Object.fromEntries(s.items.map((i) => [i.plugin, i.signInId]));

const componentsOf = (s: Shell) =>
  Object.fromEntries(s.items.map((i) => [i.plugin, i.components.map((c) => c.id)]));

describe("client shell reads", { timeout: 120_000 }, () => {
  it("the org read lists enabled running plugins with urls and integrity", async () => {
    const s = await orgRead(env.mem);
    const page = await integrity(pageSha);
    const plain = await integrity(plainSha);
    expect(s).toEqual({
      enabled: true,
      apiVersion: 1,
      items: [
        {
          plugin: PAGE,
          build: pageSha,
          entry: {
            url: `/api/v1/client/${PAGE}/${pageSha}/client.mjs`,
            integrity: page["./dist/client/client.mjs"],
          },
          styles: [
            {
              url: `/api/v1/client/${PAGE}/${pageSha}/styles/a.css`,
              integrity: page["./dist/client/styles/a.css"],
            },
          ],
          components: [
            { id: "hud", slot: "conversation.properties.section" },
            { id: "fx", slot: "shell.overlay" },
          ],
          signInId: SIGN_IN_ID,
        },
        {
          plugin: PLAIN,
          build: plainSha,
          entry: {
            url: `/api/v1/client/${PLAIN}/${plainSha}/client.mjs`,
            integrity: plain["./dist/client/client.mjs"],
          },
          styles: [],
          components: [{ id: "hud", slot: "conversation.properties.section" }],
          signInId: SIGN_IN_ID,
        },
      ],
    });
    // an awaiting org upload switched on in the org is not listed
    const bytes = await clientPlugin({
      name: "cx-org",
      components: [{ id: "hud", slot: "conversation.properties.section" }],
    });
    const base = `/api/v1/orgs/${env.orgId}/catalog/uploads`;
    const p = await env.boss({
      method: "POST",
      url: `${base}/file`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    });
    expect(p.statusCode, p.body).toBe(200);
    const c = await env.boss({
      method: "POST",
      url: `${base}/${p.json().stagingId}/confirm`,
      payload: { reviewHash: p.json().review.reviewHash },
    });
    expect(c.statusCode, c.body).toBe(201);
    await enableExtensions(env.db, env.orgId, "cx-org");
    expect((await orgRead(env.mem)).items.map((i) => i.plugin)).toEqual([PAGE, PLAIN]);
  });

  it("the sign-in id is stable for one sign-in, new after the next, and per plugin", async () => {
    const person = await signIn(env, "mem");
    const first = signInIds(await orgRead(person.req));
    expect(Object.keys(first).sort()).toEqual([PAGE, PLAIN].sort());
    // the same on every read of the sign-in, across a token refresh
    expect(signInIds(await orgRead(person.req))).toEqual(first);
    const refreshed = await person.req({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(signInIds(await orgRead(person.req))).toEqual(first);
    // per plugin: two plugins cannot correlate their ids
    expect(first[PAGE]).not.toBe(first[PLAIN]);
    // the next sign-in of the same account gets new ids
    const next = signInIds(await orgRead((await signIn(env, "mem")).req));
    expect(next[PAGE]).not.toBe(first[PAGE]);
    expect(next[PLAIN]).not.toBe(first[PLAIN]);
    // the admin read gives the same id for the same sign-in and plugin
    expect(signInIds(await adminRead())[PAGE]).toBe(signInIds(await orgRead(env.root))[PAGE]);
  });

  it("components are filtered by the viewer's role", async () => {
    // a member does not see org.settings.section components; an admin does; nobody gets platform.page
    expect(componentsOf(await orgRead(env.mem))[PAGE]).toEqual(["hud", "fx"]);
    expect(componentsOf(await orgRead(guest))[PAGE]).toEqual(["hud", "fx"]);
    expect(componentsOf(await orgRead(env.boss))[PAGE]).toEqual(["hud", "settings", "fx"]);
    expect(componentsOf(await orgRead(env.root))[PAGE]).toEqual(["hud", "settings", "fx"]);
  });

  it("another org's plugins are never listed", async () => {
    expect((await orgRead(env.root, orgB)).items).toEqual([]);
    await enableExtensions(env.db, orgB, PLAIN);
    try {
      expect((await orgRead(env.root, orgB)).items.map((i) => i.plugin)).toEqual([PLAIN]);
    } finally {
      await env.db
        .deleteFrom("extension_org_configs")
        .where("org_id", "=", orgB)
        .where("plugin", "=", PLAIN)
        .execute();
    }
    // a member of A is no member of B
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${orgB}/ui/client` });
    expect(r.statusCode).toBe(404);
  });

  it("a build of a client API the host does not run is never listed", async () => {
    const setVersion = (v: number) =>
      env.db
        .updateTable("extension_client_builds")
        .set({ api_version: v })
        .where("package_sha256", "=", plainSha)
        .execute();
    await setVersion(2);
    try {
      expect((await orgRead(env.mem)).items.map((i) => i.plugin)).toEqual([PAGE]);
      await setVersion(1);
      expect((await orgRead(env.mem)).items.map((i) => i.plugin).sort()).toEqual(
        [PAGE, PLAIN].sort(),
      );
      // the admin read drops it too
      await env.db
        .updateTable("extension_client_builds")
        .set({ api_version: 2 })
        .where("package_sha256", "=", pageSha)
        .execute();
      expect((await adminRead()).items).toEqual([]);
    } finally {
      await env.db.updateTable("extension_client_builds").set({ api_version: 1 }).execute();
    }
  });

  it("enabled false under the kill switch with no items", async () => {
    await setKillSwitch(env.root, { enabled: false });
    expect(await orgRead(env.mem)).toEqual({ enabled: false, apiVersion: 1, items: [] });
    expect(await adminRead()).toEqual({ enabled: false, apiVersion: 1, items: [] });
    await setKillSwitch(env.root, { enabled: true, disabled: [PLAIN] });
    expect((await orgRead(env.mem)).items.map((i) => i.plugin)).toEqual([PAGE]);
    await setKillSwitch(env.root, { disabled: [PAGE] });
    expect((await orgRead(env.mem)).items.map((i) => i.plugin)).toEqual([PLAIN]);
    expect((await adminRead()).items).toEqual([]);
  });

  it("the admin read lists only platform.page components and no styles", async () => {
    const page = await integrity(pageSha);
    const expected = {
      plugin: PAGE,
      build: pageSha,
      entry: {
        url: `/api/v1/client/${PAGE}/${pageSha}/client.mjs`,
        integrity: page["./dist/client/client.mjs"],
      },
      styles: [],
      components: [{ id: "page", slot: "platform.page" }],
      signInId: SIGN_IN_ID,
    };
    expect(await adminRead()).toEqual({ enabled: true, apiVersion: 1, items: [expected] });
    expect(await adminRead(`?plugin=${PAGE}`)).toEqual({
      enabled: true,
      apiVersion: 1,
      items: [expected],
    });
    expect((await adminRead(`?plugin=${PLAIN}`)).items).toEqual([]);
    expect((await adminRead("?plugin=no-such")).items).toEqual([]);
    const bad = await env.root({ method: "GET", url: "/api/v1/admin/ui/client?plugin=Bad%20Name" });
    expect(bad.statusCode).toBe(400);
  });

  it("a non super admin gets forbidden on the admin read", async () => {
    for (const req of [env.boss, env.mem]) {
      const r = await req({ method: "GET", url: "/api/v1/admin/ui/client" });
      expect(r.statusCode).toBe(403);
      expect((r.json() as { error: { code: string } }).error.code).toBe("forbidden");
    }
    const anon = await env.k.http.inject({ method: "GET", url: "/api/v1/admin/ui/client" });
    expect(anon.statusCode).toBe(401);
    const anonOrg = await env.k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/ui/client`,
    });
    expect(anonOrg.statusCode).toBe(401);
  });
});
