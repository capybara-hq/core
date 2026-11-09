import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplicaStatusStore } from "../../src/extensions/sources.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { importPlugin, type OrgEnv, startOrgEnv } from "../catalog/org-env.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, enableExtensions, PW } from "../helpers/runs.js";
import {
  clientPlugin,
  importClientPlugin,
  type Person,
  rawCode,
  rawGet,
  setKillSwitch,
  sha256,
  sha384,
  signIn,
  waitForServing,
} from "./client-env.js";

/**
 * Client file delivery (client extensions spec §9.3, plan Task 10): `GET /api/v1/client/<plugin>/
 * <build>/<file>` serves a file of the build only while the build is the current package of a
 * running extension whose client keys are approved, to a member (any role) of a live org where the
 * extension is enabled, or to a super admin when the build has a `platform.page` component. The
 * file is looked up by its exact manifest key: no decoding, no normalising, never a redirect.
 * Everything else, the kill switch included, is 404 `client.not_found`.
 */

let env: OrgEnv;
let orgB: string;
/** Member of org A (where the plugins are on). */
let mem: Person;
/** Guest of org A. */
let guest: Person;
/** Member of org B only (where they are off). */
let bmem: Person;
/** A super admin who is a member of no org. */
let sa: Person;
let pageBytes: Uint8Array;
let plainBytes: Uint8Array;
let pageSha: string;
let plainSha: string;

const PAGE = "cx-page";
const PLAIN = "cx-plain";
const url = (plugin: string, build: string, file: string) =>
  `/api/v1/client/${plugin}/${build}/${file}`;

beforeAll(async () => {
  env = await startOrgEnv();
  orgB = await createOrg(env.root, "B");
  const accounts = accountsFor(env.db);
  const guestId = (await accounts.createLocal({ login: "guest", password: PW, displayName: "G" }))
    .id;
  const bmemId = (await accounts.createLocal({ login: "bmem", password: PW, displayName: "BM" }))
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
      { org_id: env.orgId, account_id: guestId, role: "guest" },
      { org_id: orgB, account_id: bmemId, role: "member" },
    ])
    .execute();
  mem = await signIn(env, "mem");
  guest = await signIn(env, "guest");
  bmem = await signIn(env, "bmem");
  sa = await signIn(env, "nomember");
  pageBytes = await clientPlugin({
    name: PAGE,
    components: [
      { id: "page", slot: "platform.page" },
      { id: "hud", slot: "conversation.properties.section" },
    ],
    decorated: true,
  });
  plainBytes = await clientPlugin({
    name: PLAIN,
    components: [{ id: "hud", slot: "conversation.properties.section" }],
  });
  pageSha = sha256(pageBytes);
  plainSha = sha256(plainBytes);
  await importClientPlugin(env, pageBytes, PAGE);
  await importClientPlugin(env, plainBytes, PLAIN);
  await enableExtensions(env.db, env.orgId, PAGE, PLAIN);
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await env.db.deleteFrom("deployment_settings").where("key", "=", "clientExtensions").execute();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HUD = { id: "hud", slot: "conversation.properties.section" };

/** The org read's builds by plugin, as the member sees them. */
const listedBuilds = async () => {
  const r = await mem.req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/ui/client` });
  expect(r.statusCode, r.body).toBe(200);
  return Object.fromEntries(
    (r.json() as { items: { plugin: string; build: string }[] }).items.map((i) => [
      i.plugin,
      i.build,
    ]),
  );
};

const integrityOf = async (build: string, key: string) =>
  (
    await env.db
      .selectFrom("extension_client_builds")
      .select("integrity")
      .where("package_sha256", "=", build)
      .executeTakeFirstOrThrow()
  ).integrity[key];

const expectNotFound = (r: { status: number; headers: Record<string, unknown> }, code?: string) => {
  expect(r.status).toBe(404);
  expect(r.headers.location).toBeUndefined();
  expect(code).toBe("client.not_found");
};

describe("client delivery", { timeout: 120_000 }, () => {
  it("a member of an org where the plugin is on gets the bundle", async () => {
    const r = await rawGet(env, url(PAGE, pageSha, "client.mjs"), mem.cookie());
    expect(r.status, r.body.toString()).toBe(200);
    expect(r.headers["content-type"]).toBe("text/javascript");
    expect(r.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(sha384(new Uint8Array(r.body))).toBe(
      await integrityOf(pageSha, "./dist/client/client.mjs"),
    );
    // the stylesheet: text/css with its charset
    const css = await rawGet(env, url(PAGE, pageSha, "styles/a.css"), mem.cookie());
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["content-security-policy"]).toBeUndefined();
    expect(sha384(new Uint8Array(css.body))).toBe(
      await integrityOf(pageSha, "./dist/client/styles/a.css"),
    );
  });

  it("a guest of that org gets it too", async () => {
    const r = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), guest.cookie());
    expect(r.status).toBe(200);
  });

  it("a member of an org where the plugin is off gets 404 client.not_found", async () => {
    const r = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), bmem.cookie());
    expectNotFound(r, rawCode(r));
    // switched on in B: served; switched off in A: the guest of A no longer gets it
    await enableExtensions(env.db, orgB, PLAIN);
    expect((await rawGet(env, url(PLAIN, plainSha, "client.mjs"), bmem.cookie())).status).toBe(200);
    await env.db
      .updateTable("extension_org_configs")
      .set({ enabled: false })
      .where("plugin", "=", PLAIN)
      .execute();
    const off = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), guest.cookie());
    expectNotFound(off, rawCode(off));
    await enableExtensions(env.db, env.orgId, PLAIN);
    await env.db
      .deleteFrom("extension_org_configs")
      .where("plugin", "=", PLAIN)
      .where("org_id", "=", orgB)
      .execute();
    // a deleted org is not a live org
    await enableExtensions(env.db, orgB, PLAIN);
    await env.db
      .updateTable("orgs")
      .set({ deleted_at: new Date() })
      .where("id", "=", orgB)
      .execute();
    try {
      const gone = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), bmem.cookie());
      expectNotFound(gone, rawCode(gone));
    } finally {
      await env.db.updateTable("orgs").set({ deleted_at: null }).where("id", "=", orgB).execute();
      await env.db
        .deleteFrom("extension_org_configs")
        .where("plugin", "=", PLAIN)
        .where("org_id", "=", orgB)
        .execute();
    }
  });

  it("an awaiting org upload is 404", async () => {
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
    const prepared = p.json() as { stagingId: string; review: { reviewHash: string } };
    const c = await env.boss({
      method: "POST",
      url: `${base}/${prepared.stagingId}/confirm`,
      payload: { reviewHash: prepared.review.reviewHash },
    });
    expect(c.statusCode, c.body).toBe(201);
    expect((c.json() as { outcome: string }).outcome).toBe("pending");
    const sha = sha256(bytes);
    // the build is stored with the package, the org has it switched on: still nothing is served
    expect(
      await env.db
        .selectFrom("extension_client_builds")
        .select("plugin")
        .where("package_sha256", "=", sha)
        .executeTakeFirst(),
    ).toEqual({ plugin: "cx-org" });
    await enableExtensions(env.db, env.orgId, "cx-org");
    for (const who of [mem, sa]) {
      const r = await rawGet(env, url("cx-org", sha, "client.mjs"), who.cookie());
      expectNotFound(r, rawCode(r));
    }
  });

  it("an unapproved snapshot is 404", async () => {
    const snapshot = () =>
      env.db
        .selectFrom("extension_permission_snapshots")
        .select("permissions")
        .where("plugin", "=", PLAIN)
        .executeTakeFirstOrThrow();
    const before = (await snapshot()).permissions as {
      permissions: { client: boolean; ui: { components: string[] } };
    };
    const write = (permissions: unknown) =>
      env.db
        .updateTable("extension_permission_snapshots")
        .set({ permissions: JSON.stringify(permissions) })
        .where("plugin", "=", PLAIN)
        .execute();
    try {
      // the client key is not approved
      await write({ ...before, permissions: { ...before.permissions, client: false } });
      const noClient = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), mem.cookie());
      expectNotFound(noClient, rawCode(noClient));
      // a component key is not approved
      await write({
        ...before,
        permissions: { ...before.permissions, ui: { ...before.permissions.ui, components: [] } },
      });
      const noComponent = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), mem.cookie());
      expectNotFound(noComponent, rawCode(noComponent));
    } finally {
      await write(before);
    }
    expect((await rawGet(env, url(PLAIN, plainSha, "client.mjs"), mem.cookie())).status).toBe(200);
  });

  it("an old build is 404 after the upgrade", async () => {
    const v2 = await clientPlugin({
      name: "cx-up",
      version: "2.0.0",
      components: [{ id: "hud", slot: "conversation.properties.section" }],
    });
    const v1 = await clientPlugin({
      name: "cx-up",
      components: [{ id: "hud", slot: "conversation.properties.section" }],
    });
    await importClientPlugin(env, v1, "cx-up");
    await enableExtensions(env.db, env.orgId, "cx-up");
    expect((await rawGet(env, url("cx-up", sha256(v1), "client.mjs"), mem.cookie())).status).toBe(
      200,
    );
    await importClientPlugin(env, v2, "cx-up", "2.0.0");
    const old = await rawGet(env, url("cx-up", sha256(v1), "client.mjs"), mem.cookie());
    expectNotFound(old, rawCode(old));
    const now = await rawGet(env, url("cx-up", sha256(v2), "client.mjs"), mem.cookie());
    expect(now.status).toBe(200);
    expect(now.body.toString()).toContain('v: "2.0.0"');
  });

  it("an upgrade awaiting approval keeps delivering and listing the build that runs", async () => {
    const v1 = await clientPlugin({ name: "cx-wait", components: [HUD] });
    // 2.0.0 adds a component: a blocking key the snapshot has not approved
    const v2 = await clientPlugin({
      name: "cx-wait",
      version: "2.0.0",
      components: [HUD, { id: "hud2", slot: "conversation.properties.section" }],
    });
    await importClientPlugin(env, v1, "cx-wait");
    await enableExtensions(env.db, env.orgId, "cx-wait");
    const config = env.k.app.get(KernelConfigService);
    const real = config.get();
    vi.spyOn(config, "get").mockReturnValue({
      ...real,
      extensionPermissions: { ...real.extensionPermissions, autoApprove: false },
    });
    // the package is stored by the review; the install moves to it, the approval waits
    const p = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(v2),
    });
    expect(p.statusCode, p.body).toBe(200);
    const moved = await env.root({
      method: "POST",
      url: "/api/v1/admin/extensions/cx-wait/install",
      payload: { sha256: sha256(v2) },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    await waitForServing(env, "cx-wait", sha256(v2), "pending", sha256(v1));
    expect(
      await env.db
        .selectFrom("extension_installs")
        .select("sha256")
        .where("name", "=", "cx-wait")
        .executeTakeFirstOrThrow(),
    ).toEqual({ sha256: sha256(v2) });
    const old = await rawGet(env, url("cx-wait", sha256(v1), "client.mjs"), mem.cookie());
    expect(old.status, old.body.toString()).toBe(200);
    expect(old.body.toString()).toContain('v: "1.0.0"');
    const next = await rawGet(env, url("cx-wait", sha256(v2), "client.mjs"), mem.cookie());
    expectNotFound(next, rawCode(next));
    expect((await listedBuilds())["cx-wait"]).toBe(sha256(v1));
  });

  it("a failed upgrade keeps delivering and listing the build that runs", async () => {
    const v1 = await clientPlugin({ name: "cx-fail", components: [HUD] });
    const v2 = await clientPlugin({
      name: "cx-fail",
      version: "2.0.0",
      components: [HUD],
      setupThrows: true,
    });
    await importClientPlugin(env, v1, "cx-fail");
    await enableExtensions(env.db, env.orgId, "cx-fail");
    await importPlugin(env, v2);
    await waitForServing(env, "cx-fail", sha256(v2), "failed", sha256(v1));
    expect((await rawGet(env, url("cx-fail", sha256(v1), "client.mjs"), mem.cookie())).status).toBe(
      200,
    );
    const next = await rawGet(env, url("cx-fail", sha256(v2), "client.mjs"), mem.cookie());
    expectNotFound(next, rawCode(next));
    expect((await listedBuilds())["cx-fail"]).toBe(sha256(v1));
  });

  it("no live replica serving the build is 404 (fails closed)", async () => {
    const bytes = await clientPlugin({ name: "cx-stale", components: [HUD] });
    await importClientPlugin(env, bytes, "cx-stale");
    await enableExtensions(env.db, env.orgId, "cx-stale");
    const path = url("cx-stale", sha256(bytes), "client.mjs");
    expect((await rawGet(env, path, mem.cookie())).status).toBe(200);
    // the replica stops reporting (as a stalled or crashed one does): no heartbeat, no row writes
    const store = env.k.app.get(ReplicaStatusStore);
    vi.spyOn(store, "heartbeat").mockResolvedValue();
    const write = store.write.bind(store);
    vi.spyOn(store, "write").mockImplementation(async (st) => {
      if (st.plugin !== "cx-stale") await write(st);
    });
    await env.db
      .updateTable("extension_replica_status")
      .set({ heartbeat_at: new Date(Date.now() - 3_600_000) })
      .where("plugin", "=", "cx-stale")
      .execute();
    const r = await rawGet(env, path, mem.cookie());
    expectNotFound(r, rawCode(r));
    expect(await listedBuilds()).not.toHaveProperty("cx-stale");
  });

  it("HEAD answers like GET without a body, through the same check", async () => {
    const ok = await rawGet(env, url(PAGE, pageSha, "client.mjs"), mem.cookie(), "HEAD");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("text/javascript");
    expect(ok.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(ok.body.length).toBe(0);
    const off = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), bmem.cookie(), "HEAD");
    expect(off.status).toBe(404);
    expect(off.headers.location).toBeUndefined();
    expect((await rawGet(env, url(PAGE, pageSha, "client.mjs"), undefined, "HEAD")).status).toBe(
      401,
    );
  });

  it("an unknown file is 404", async () => {
    for (const path of [
      url(PAGE, pageSha, "nope.mjs"),
      url(PAGE, pageSha, "styles/b.css"),
      url(PAGE, pageSha, "plugin.json"),
      url(PAGE, plainSha, "client.mjs"),
      url(PLAIN, pageSha, "client.mjs"),
      url(PAGE, "0".repeat(64), "client.mjs"),
      url("no-such", pageSha, "client.mjs"),
    ]) {
      const r = await rawGet(env, path, mem.cookie());
      expect(r.status, path).toBe(404);
      expect(rawCode(r), path).toBe("client.not_found");
      // the requested path is never echoed
      expect(r.body.toString(), path).not.toContain("nope");
    }
  });

  it("a path with .. is 404", async () => {
    for (const file of [
      "..%2F..%2Fx",
      "styles/..%2Fclient.mjs",
      "styles%2Fa.css",
      "styles%2fa.css",
      "styles%5Ca.css",
      "styles\\a.css",
      "%2e%2e/client.mjs",
      "styles/%2e%2e/client.mjs",
      "styles/../client.mjs",
      "./client.mjs",
      "styles/./a.css",
      "styles//a.css",
      "client.mjs/",
      "CLIENT.mjs",
      "client%2Emjs",
      "client.mjs%00",
    ]) {
      const r = await rawGet(env, url(PAGE, pageSha, file), mem.cookie());
      expect(r.status, file).toBe(404);
      expect(r.headers.location, file).toBeUndefined();
      // every one reaches the route (the router normalises nothing) and gets its refusal
      expect(rawCode(r), file).toBe("client.not_found");
    }
    // the same files spelled exactly are served
    for (const file of ["client.mjs", "styles/a.css"]) {
      expect((await rawGet(env, url(PAGE, pageSha, file), mem.cookie())).status, file).toBe(200);
    }
  });

  it("signed out is 401", async () => {
    const r = await rawGet(env, url(PAGE, pageSha, "client.mjs"));
    expect(r.status).toBe(401);
    expect(rawCode(r)).toBe("auth.required");
  });

  it("a super admin who is no member gets only builds with a platform.page component", async () => {
    expect((await rawGet(env, url(PAGE, pageSha, "client.mjs"), sa.cookie())).status).toBe(200);
    expect((await rawGet(env, url(PAGE, pageSha, "styles/a.css"), sa.cookie())).status).toBe(200);
    const plain = await rawGet(env, url(PLAIN, plainSha, "client.mjs"), sa.cookie());
    expectNotFound(plain, rawCode(plain));
  });

  it("the kill switch and disabled refuse delivery", async () => {
    await setKillSwitch(env.root, { enabled: false });
    for (const [who, path] of [
      [mem, url(PAGE, pageSha, "client.mjs")],
      [mem, url(PLAIN, plainSha, "client.mjs")],
      [sa, url(PAGE, pageSha, "client.mjs")],
    ] as const) {
      const r = await rawGet(env, path, who.cookie());
      expectNotFound(r, rawCode(r));
    }
    await setKillSwitch(env.root, { enabled: true, disabled: [PAGE] });
    const page = await rawGet(env, url(PAGE, pageSha, "client.mjs"), mem.cookie());
    expectNotFound(page, rawCode(page));
    const asSuper = await rawGet(env, url(PAGE, pageSha, "client.mjs"), sa.cookie());
    expectNotFound(asSuper, rawCode(asSuper));
    expect((await rawGet(env, url(PLAIN, plainSha, "client.mjs"), mem.cookie())).status).toBe(200);
    await setKillSwitch(env.root, { disabled: [] });
    expect((await rawGet(env, url(PAGE, pageSha, "client.mjs"), mem.cookie())).status).toBe(200);
  });

  it("an svg asset carries the sandbox CSP", async () => {
    const r = await rawGet(env, url(PAGE, pageSha, "assets/logo.svg"), mem.cookie());
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/svg+xml");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });
});
