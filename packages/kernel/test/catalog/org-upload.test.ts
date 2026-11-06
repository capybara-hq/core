import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PluginImport } from "../../src/catalog/plugin-import.js";
import { blobKey } from "../../src/extensions/blobs.js";
import { usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, PW, type Req, session, waitFor } from "../helpers/runs.js";
import {
  importPlugin,
  type OrgEnv,
  resetOrgCatalog,
  setDeployment,
  setScope,
  startOrgEnv,
} from "./org-env.js";
import { bundlePlugin, mcpTemplate, skillPlugin, templatePlugin } from "./packages.js";

/**
 * Plugin scope phase 3, Task 4 (spec §14, rulings P3-7, P3-8, P3-13, P3-14, P3-15'): an org admin
 * uploads a plugin tgz without an extension. It is reviewed like a platform import, then owned by
 * the org, scope `named: [owner]`, installed there by the scope sync. Staging is per org; custom
 * deny refuses by content; a name live for another owner is refused naming the owner; dependencies
 * must be usable by the org.
 */

let env: OrgEnv;
/** `env.orgId` is org A ("Acme"; boss is its admin, mem a member, guest a guest). */
let orgA: string;
/** Org B ("B"; root is its owner). */
let orgB: string;
/** Org C ("C"; root is its owner). */
let orgC: string;
let guest: Req;

beforeAll(async () => {
  env = await startOrgEnv();
  orgA = env.orgId;
  orgB = await createOrg(env.root, "B");
  orgC = await createOrg(env.root, "C");
  const guestId = (
    await accountsFor(env.db).createLocal({ login: "guest", password: PW, displayName: "G" })
  ).id;
  await env.db
    .insertInto("memberships")
    .values({ org_id: orgA, account_id: guestId, role: "guest" })
    .execute();
  guest = await session(env.k, "guest");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

const base = (orgId: string) => `/api/v1/orgs/${orgId}/catalog/uploads`;

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

const detailsOf = (r: { body: string }) =>
  (JSON.parse(r.body) as { error: { details?: unknown[] } }).error.details;

const upload = (req: Req, orgId: string, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: `${base(orgId)}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });

async function prepared(req: Req, orgId: string, bytes: Uint8Array) {
  const r = await upload(req, orgId, bytes);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as {
    stagingId: string;
    review: { name: string; reviewHash: string; skills: { name: string }[] };
    update: unknown;
  };
}

const confirm = (
  req: Req,
  orgId: string,
  p: { stagingId: string; review: { reviewHash: string } },
  body: Record<string, unknown> = {},
) =>
  req({
    method: "POST",
    url: `${base(orgId)}/${p.stagingId}/confirm`,
    payload: { reviewHash: p.review.reviewHash, ...body },
  });

const liveItem = (name: string) =>
  env.db
    .selectFrom("catalog_items")
    .selectAll()
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

describe("org plugin upload without an extension", () => {
  it("org admin uploads a declarative plugin", async () => {
    const p = await prepared(env.boss, orgA, await skillPlugin("crm", { skill: "crm-notes" }));
    expect(p.review.name).toBe("crm");
    expect(p.review.skills.map((s) => s.name)).toEqual(["crm-notes"]);
    expect(p.update).toBeNull();
    const c = await confirm(env.boss, orgA, p, { shareable: true });
    expect(c.statusCode, c.body).toBe(201);
    const body = c.json() as {
      item: { id: string; scope: string; owner: unknown; shareable: boolean };
      outcome: string;
    };
    expect(body.outcome).toBe("installed");
    expect(body.item.owner).toEqual({ kind: "org", orgId: orgA, name: "Acme" });
    expect(body.item.scope).toBe("named");
    const item = await liveItem("crm");
    expect(item).toMatchObject({
      owner_org_id: orgA,
      shareable: true,
      shown_to_others: false,
      scope: "named",
    });
    const listed = await env.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", body.item.id)
      .execute();
    expect(listed.map((r) => r.org_id)).toEqual([orgA]);
    // its components carry the owner (P3-2, F27)
    const skill = await env.db
      .selectFrom("platform_skills")
      .select(["owner_org_id", "origin_org_id", "shareable", "shown_to_others"])
      .where("catalog_item_id", "=", body.item.id)
      .executeTakeFirstOrThrow();
    expect(skill).toEqual({
      owner_org_id: orgA,
      origin_org_id: orgA,
      shareable: true,
      shown_to_others: false,
    });
    // the scope sync installs it in A only
    await waitFor(
      async () => (await usableSkills(env.db, orgA)).some((s) => s.name === "crm-notes"),
      15_000,
      "the skill in org A",
    );
    expect((await usableSkills(env.db, orgB)).map((s) => s.name)).not.toContain("crm-notes");
    // not shareable by default
    const q = await prepared(env.boss, orgA, await skillPlugin("crm2"));
    expect((await confirm(env.boss, orgA, q)).statusCode).toBe(201);
    expect(await liveItem("crm2")).toMatchObject({ owner_org_id: orgA, shareable: false });
  });

  it("member cannot upload; guest neither", async () => {
    const bytes = await skillPlugin("crm");
    expect(errorOf(await upload(env.mem, orgA, bytes))).toEqual([403, "forbidden"]);
    expect(errorOf(await upload(guest, orgA, bytes))).toEqual([403, "forbidden"]);
    // nor confirm an admin's staging
    const p = await prepared(env.boss, orgA, bytes);
    expect(errorOf(await confirm(env.mem, orgA, p))).toEqual([403, "forbidden"]);
    expect(await liveItem("crm")).toBeUndefined();
  });

  it("the org role is checked before the body is read (ruling P3-29)", async () => {
    // A body that never ends: answering at all proves the kernel did not wait to read it
    const endless = (): Readable => {
      let sent = 0;
      return new Readable({
        read() {
          if (sent < 5 * 1024 * 1024) {
            sent += 1024 * 1024;
            this.push(Buffer.alloc(1024 * 1024, 7));
          }
          // never pushes null: a reader would wait forever
        },
      });
    };
    const send = (req: Req, orgId: string) =>
      Promise.race([
        req({
          method: "POST",
          url: `${base(orgId)}/file`,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(40 * 1024 * 1024),
          },
          payload: endless(),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("the body was read before the role check")), 3_000),
        ),
      ]);
    expect(errorOf(await send(env.mem, orgA))).toEqual([403, "forbidden"]);
    expect(errorOf(await send(guest, orgA))).toEqual([403, "forbidden"]);
    // boss is not a member of org B: as OrgGuard, the org is not disclosed
    expect(errorOf(await send(env.boss, orgB))).toEqual([404, "org.not_found"]);
  }, 20_000);

  it("names of bootstrap and marketplace plugins are reserved (ruling P3-28)", async () => {
    // a bootstrap plugin of the bundled manifest
    const r = await upload(env.boss, orgA, await skillPlugin("anthropic"));
    expect(errorOf(r)).toEqual([409, "plugin.name_reserved"]);
    // an entry of a marketplace the deployment has read
    const marketplaceId = randomUUID();
    await env.db
      .insertInto("marketplaces")
      .values({
        id: marketplaceId,
        name: "Acme market",
        url: "https://m.example.com/m.json",
        mirrors: "[]",
      })
      .execute();
    try {
      await env.db
        .insertInto("marketplace_entries")
        .values({ source_id: marketplaceId, name: "market-crm", version: "1.0.0", entry: "{}" })
        .execute();
      const m = await upload(env.boss, orgA, await skillPlugin("market-crm"));
      expect(errorOf(m)).toEqual([409, "plugin.name_reserved"]);
      // a free name passes
      const free = await prepared(env.boss, orgA, await skillPlugin("acme-own-crm"));
      expect(free.review.name).toBe("acme-own-crm");
    } finally {
      await env.db.deleteFrom("marketplaces").where("id", "=", marketplaceId).execute();
    }
  });

  it("an expired org staging takes its extension package with it", async () => {
    const p = await prepared(env.boss, orgA, await skillPlugin("ext-expire", { extension: {} }));
    const sha = (p.review as unknown as { extension: { sha256: string } }).extension.sha256;
    const pkg = await env.db
      .selectFrom("extension_packages")
      .select("blob_store")
      .where("sha256", "=", sha)
      .executeTakeFirstOrThrow();
    expect(pkg.blob_store).toBe("object");
    const store = env.k.app.get(StorageService).deployment();
    expect(await store.head(blobKey(sha))).not.toBeNull();
    // a platform staging of another extension package keeps its package (it may be confirmed later)
    const a = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await skillPlugin("ext-platform", { extension: {} })),
    });
    expect(a.statusCode, a.body).toBe(200);
    const platformSha = a.json().review.extension.sha256 as string;
    await env.db
      .updateTable("plugin_import_staging")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect(await env.k.app.get(PluginImport).cleanupExpired()).toBe(2);
    expect(
      await env.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("sha256", "=", sha)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await store.head(blobKey(sha))).toBeNull();
    expect(
      await env.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("sha256", "=", platformSha)
        .executeTakeFirst(),
    ).toBeDefined();
  });

  it("staging is per org", async () => {
    const p = await prepared(env.boss, orgA, await skillPlugin("crm"));
    const own = await env.boss({ method: "GET", url: `${base(orgA)}/${p.stagingId}` });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ stagingId: p.stagingId, review: { name: "crm" } });
    // org B (root is its owner) does not see org A's staging
    const other = await env.root({ method: "GET", url: `${base(orgB)}/${p.stagingId}` });
    expect(errorOf(other)).toEqual([404, "plugin.staging_not_found"]);
    expect(errorOf(await confirm(env.root, orgB, p))).toEqual([404, "plugin.staging_not_found"]);
    // nor does the super admin's import route
    const admin = await env.root({
      method: "GET",
      url: `/api/v1/admin/catalog/imports/${p.stagingId}`,
    });
    expect(errorOf(admin)).toEqual([404, "plugin.staging_not_found"]);
    const adminConfirm = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/imports/${p.stagingId}/confirm`,
      payload: { reviewHash: p.review.reviewHash },
    });
    expect(errorOf(adminConfirm)).toEqual([404, "plugin.staging_not_found"]);
    // and the super admin's staging is not on the org route
    const a = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await skillPlugin("platform-one")),
    });
    expect(a.statusCode, a.body).toBe(200);
    const sid = a.json().stagingId as string;
    expect(errorOf(await env.boss({ method: "GET", url: `${base(orgA)}/${sid}` }))).toEqual([
      404,
      "plugin.staging_not_found",
    ]);
    expect(
      errorOf(await confirm(env.boss, orgA, { stagingId: sid, review: a.json().review })),
    ).toEqual([404, "plugin.staging_not_found"]);
  });

  it("custom deny refuses by content (ruling P3-15')", async () => {
    await setDeployment(env, { customSkills: "deny" });
    expect(errorOf(await upload(env.boss, orgA, await skillPlugin("crm")))).toEqual([
      403,
      "catalog.custom_disabled",
    ]);
    // a package without skills or agent templates is not a custom skill
    const t = await prepared(env.boss, orgA, await templatePlugin("gh", mcpTemplate()));
    expect(t.review.name).toBe("gh");
    await setDeployment(env, { customSkills: "allow", customConnectors: "deny" });
    // skills only: allowed under customConnectors deny
    const s = await prepared(env.boss, orgA, await skillPlugin("crm"));
    expect(s.review.name).toBe("crm");
    // a connector template: refused
    expect(
      errorOf(await upload(env.boss, orgA, await templatePlugin("gh2", mcpTemplate()))),
    ).toEqual([403, "catalog.custom_disabled"]);
    // and confirm checks again: the connector staging prepared while allowed is refused now
    expect(errorOf(await confirm(env.boss, orgA, t))).toEqual([403, "catalog.custom_disabled"]);
    expect(await liveItem("gh")).toBeUndefined();
    const ok = await confirm(env.boss, orgA, s);
    expect(ok.statusCode, ok.body).toBe(201);
    await setDeployment(env, { customConnectors: "allow" });
  });

  it("taken names name the owner (P3-14)", async () => {
    await importPlugin(env, await skillPlugin("foo"));
    const r = await upload(env.boss, orgA, await skillPlugin("foo"));
    expect(errorOf(r)).toEqual([409, "plugin.name_taken"]);
    expect(detailsOf(r)).toEqual([{ owner: { kind: "platform" } }]);
    // an org B item `bar`
    const b = await prepared(env.root, orgB, await skillPlugin("bar"));
    expect((await confirm(env.root, orgB, b)).statusCode).toBe(201);
    const r2 = await upload(env.boss, orgA, await skillPlugin("bar"));
    expect(errorOf(r2)).toEqual([409, "plugin.name_taken"]);
    expect(detailsOf(r2)).toEqual([{ owner: { kind: "org", orgId: orgB, name: "B" } }]);
    // the super admin importing `bar`
    const r3 = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await skillPlugin("bar", { version: "2.0.0" })),
    });
    expect(errorOf(r3)).toEqual([409, "plugin.name_taken"]);
    expect(detailsOf(r3)).toEqual([{ owner: { kind: "org", orgId: orgB, name: "B" } }]);
    // the same org uploading its own name is a new version
    const v2 = await prepared(env.root, orgB, await skillPlugin("bar", { version: "2.0.0" }));
    const c = await confirm(env.root, orgB, v2);
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().outcome).toBe("updated");
  });

  it("name race between two orgs", async () => {
    const a = await prepared(env.boss, orgA, await skillPlugin("baz"));
    const b = await prepared(env.root, orgB, await skillPlugin("baz", { skill: "baz-b" }));
    expect((await confirm(env.boss, orgA, a)).statusCode).toBe(201);
    const r = await confirm(env.root, orgB, b);
    expect(errorOf(r)).toEqual([409, "plugin.name_taken"]);
    expect(detailsOf(r)).toEqual([{ owner: { kind: "org", orgId: orgA, name: "Acme" } }]);
    const items = await env.db
      .selectFrom("catalog_items")
      .select(["id", "owner_org_id"])
      .where("name", "=", "baz")
      .execute();
    expect(items).toEqual([{ id: expect.any(String), owner_org_id: orgA }]);
    const versions = await env.db
      .selectFrom("catalog_item_versions")
      .select("version")
      .where("item_id", "=", items[0]?.id as string)
      .execute();
    expect(versions).toHaveLength(1);
    expect(
      await env.db.selectFrom("platform_skills").select("id").where("name", "=", "baz-b").execute(),
    ).toEqual([]);
    // B's staging row stays until it expires
    const staging = await env.db
      .selectFrom("plugin_import_staging")
      .select(["id", "org_id"])
      .where("id", "=", b.stagingId)
      .executeTakeFirst();
    expect(staging).toEqual({ id: b.stagingId, org_id: orgB });
  });

  it("a dependency must be usable by the org (P3-13)", async () => {
    const onlyC = await importPlugin(env, await skillPlugin("dep-c"));
    await setScope(env, onlyC, "named", [orgC]);
    const needsC = await bundlePlugin({
      name: "wants-c",
      skills: ["wants-c"],
      dependencies: [{ name: "dep-c", version: "^1.0.0" }],
    });
    const r = await upload(env.boss, orgA, needsC);
    expect(errorOf(r)).toEqual([409, "plugin.dependency_unavailable"]);
    expect(detailsOf(r)).toEqual([{ dependencies: ["dep-c"] }]);
    // an optional platform dependency is accepted
    await importPlugin(env, await skillPlugin("dep-opt"));
    const p = await prepared(
      env.boss,
      orgA,
      await bundlePlugin({
        name: "wants-opt",
        skills: ["wants-opt"],
        dependencies: [{ name: "dep-opt", version: "^1.0.0" }],
      }),
    );
    // made unusable between prepare and confirm: refused at confirm
    const optId = (await liveItem("dep-opt"))?.id as string;
    await env.db
      .updateTable("catalog_items")
      .set({ disabled: true })
      .where("id", "=", optId)
      .execute();
    expect(errorOf(await confirm(env.boss, orgA, p))).toEqual([
      409,
      "plugin.dependency_unavailable",
    ]);
    await env.db
      .updateTable("catalog_items")
      .set({ disabled: false })
      .where("id", "=", optId)
      .execute();
    const c = await confirm(env.boss, orgA, p);
    expect(c.statusCode, c.body).toBe(201);
    // an unknown dependency is unavailable too
    const unknown = await upload(
      env.boss,
      orgA,
      await bundlePlugin({
        name: "wants-x",
        skills: ["wants-x"],
        dependencies: [{ name: "nowhere", version: "^1.0.0" }],
      }),
    );
    expect(errorOf(unknown)).toEqual([409, "plugin.dependency_unavailable"]);
  });

  it("a package with an extension is reviewed, but its confirm answers 501 until Task 6", async () => {
    const bytes = await skillPlugin("with-ext", { extension: {} });
    const p = await prepared(env.boss, orgA, bytes);
    expect(p.review).toMatchObject({ extension: { name: "with-ext", action: "install" } });
    expect(errorOf(await confirm(env.boss, orgA, p))).toEqual([
      501,
      "plugin.extension_upload_pending",
    ]);
    expect(await liveItem("with-ext")).toBeUndefined();
    expect(
      await env.db
        .selectFrom("extension_installs")
        .select("name")
        .where("name", "=", "with-ext")
        .execute(),
    ).toEqual([]);
  });
});
