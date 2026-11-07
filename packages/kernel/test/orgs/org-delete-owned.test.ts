import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import { ExtensionAdminOps } from "../../src/extensions/admin-ops.js";
import { runOutsideTransaction } from "../../src/infra/database/transaction-host.js";
import { usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
import {
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setDeployment,
  setScope,
  startOrgEnv,
} from "../catalog/org-env.js";
import { skillPlugin } from "../catalog/packages.js";
import { lifePkg } from "../helpers/plugin-packages.js";
import { createOrg, enableExtensions, type Req, waitFor } from "../helpers/runs.js";

/**
 * Plugin scope phase 3, Task 9 (spec §14, P3-20, P3-21; pre-flight F9, F10, F28): deleting an org
 * runs the owner-delete rule for everything it owns, in the delete's transaction. A plugin or a
 * promoted skill another org uses is transferred to the platform (platform notice
 * `ownership_transferred`, reason `org_deleted`); anything else is removed, an org plugin's
 * extension taken out by the cleanup job after the commit. A pending first upload is removed and
 * its extension name released; a staging confirmed after the deletion is 404; a super admin
 * confirmation racing the deletion (or the owner's delete) answers 409 `catalog.item_removed` and
 * leaves no extension installed.
 */

let env: OrgEnv;
/** Org B ("B"; root is its owner): the org that uses what the deleted org shared. */
let orgB: string;
let seq = 0;

beforeAll(async () => {
  env = await startOrgEnv();
  orgB = await createOrg(env.root, "B");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await setDeployment(env, { customSkills: "allow" });
  await env.db.deleteFrom("org_notices").execute();
  await env.db.deleteFrom("platform_notices").execute();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

/** A new org owned by root (super admin), deleted by the test. */
const newOrg = () => createOrg(env.root, `Gone ${++seq}`);

const uploads = (orgId: string) => `/api/v1/orgs/${orgId}/catalog/uploads`;
const owned = (orgId: string, itemId: string) => `/api/v1/orgs/${orgId}/owned-plugins/${itemId}`;

async function prepare(req: Req, orgId: string, bytes: Uint8Array) {
  const p = await req({
    method: "POST",
    url: `${uploads(orgId)}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(p.statusCode, p.body).toBe(200);
  return p.json() as { stagingId: string; review: { reviewHash: string } };
}

/** Uploads and confirms a package in the org; returns the item id after asserting the outcome. */
async function uploaded(
  orgId: string,
  bytes: Uint8Array,
  outcome: "pending" | "installed",
  req: Req = env.root,
): Promise<string> {
  const prepared = await prepare(req, orgId, bytes);
  const c = await req({
    method: "POST",
    url: `${uploads(orgId)}/${prepared.stagingId}/confirm`,
    payload: { reviewHash: prepared.review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  expect((c.json() as { outcome: string }).outcome).toBe(outcome);
  return (c.json() as { item: { id: string } }).item.id;
}

/** The permission digest the super admin confirms a pending org upload with. */
async function digestOf(itemId: string): Promise<string> {
  const list = await env.root({ method: "GET", url: "/api/v1/admin/catalog/items?pending=true" });
  const digest = (list.json() as { items: { id: string; permissionsHash: string }[] }).items.find(
    (i) => i.id === itemId,
  )?.permissionsHash;
  expect(digest).toBeTruthy();
  return digest as string;
}

const confirmUpload = (itemId: string, permissionsHash: string) =>
  env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/confirm`,
    payload: { permissionsHash },
  });

const deleteOrg = (orgId: string) => env.root({ method: "DELETE", url: `/api/v1/orgs/${orgId}` });

const usable = async (orgId: string) => (await usableSkills(env.db, orgId)).map((s) => s.name);

const installRow = (name: string) =>
  env.db
    .selectFrom("extension_installs")
    .select(["sha256", "desired_state"])
    .where("name", "=", name)
    .executeTakeFirst();

const claimOf = (name: string) =>
  env.db
    .selectFrom("extension_name_owners")
    .select("package_name")
    .where("name", "=", name)
    .executeTakeFirst();

const itemRow = (itemId: string) =>
  env.db
    .selectFrom("catalog_items")
    .select(["deleted_at", "owner_org_id", "awaiting_confirmation", "pending_version"])
    .where("id", "=", itemId)
    .executeTakeFirstOrThrow();

/** Waits until the cleanup job took the extension out and released its name. */
async function cleanedUp(name: string): Promise<void> {
  await waitFor(
    async () => (await installRow(name)) === undefined && (await claimOf(name)) === undefined,
    30_000,
    `${name} uninstalled and its name released`,
  );
}

/** Org `orgId` uploads `name` (extension + skill `<name>-notes`), the super admin confirms it. */
async function confirmedIn(orgId: string, name: string): Promise<string> {
  const itemId = await uploaded(
    orgId,
    await lifePkg({ name, version: "1.0.0", skills: [`${name}-notes`] }),
    "pending",
  );
  const c = await confirmUpload(itemId, await digestOf(itemId));
  expect(c.statusCode, c.body).toBe(200);
  await waitFor(
    async () => (await usable(orgId)).includes(`${name}-notes`),
    30_000,
    `${name}-notes usable in its owner org`,
  );
  return itemId;
}

/** The owner shares its plugin and the super admin associates it with org B, where it is on. */
async function sharedWithB(orgId: string, itemId: string, skill: string): Promise<void> {
  const s = await env.root({
    method: "PUT",
    url: `${owned(orgId, itemId)}/shareable`,
    payload: { shareable: true },
  });
  expect(s.statusCode, s.body).toBe(204);
  await setScope(env, itemId, "named", [orgId, orgB]);
  await env.db
    .updateTable("catalog_items")
    .set({ scope_version: sql<number>`scope_version + 1` })
    .where("id", "=", itemId)
    .execute();
  await env.k.app.get(CatalogScopeService).enqueueSync(itemId);
  await waitFor(async () => (await usable(orgB)).includes(skill), 30_000, `${skill} usable in B`);
}

/** An org skill of `orgId` made shareable and associated with org B (promoted); its platform id. */
async function promotedSkill(orgId: string, name: string): Promise<string> {
  const r = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/skills`,
    payload: { name, description: `Use for ${name} work.`, body: `# ${name}\n\nDo it.` },
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = (r.json() as { skill: { id: string } }).skill.id;
  const s = await env.root({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/skills/${id}/shareable`,
    payload: { shareable: true },
  });
  expect(s.statusCode, s.body).toBe(200);
  const body = { scope: "named", orgs: [orgId, orgB] };
  const p = await env.root({
    method: "POST",
    url: `/api/v1/admin/components/skill/${id}/scope/preview`,
    payload: body,
  });
  expect(p.statusCode, p.body).toBe(200);
  const put = await env.root({
    method: "PUT",
    url: `/api/v1/admin/components/skill/${id}/scope`,
    payload: { ...body, scopeHash: p.json().scopeHash },
  });
  expect(put.statusCode, put.body).toBe(200);
  const platformId = put.json().id as string;
  expect(platformId).not.toBe(id);
  return platformId;
}

describe("org deletion and what the org owns", { timeout: 180_000 }, () => {
  it("shared items survive their org", async () => {
    const orgX = await newOrg();
    const shared = await uploaded(orgX, await skillPlugin("del-shared"), "installed");
    await sharedWithB(orgX, shared, "del-shared");
    const report = await promotedSkill(orgX, "del-report");
    await waitFor(
      async () => (await usable(orgB)).includes("del-report"),
      30_000,
      "del-report usable in B",
    );
    const solo = await confirmedIn(orgX, "del-solo");

    const d = await deleteOrg(orgX);
    expect(d.statusCode, d.body).toBe(204);

    // the shared plugin and the promoted skill are the platform's now, still on in B
    expect(await itemRow(shared)).toMatchObject({ deleted_at: null, owner_org_id: null });
    const skill = await env.db
      .selectFrom("platform_skills")
      .select(["owner_org_id", "deleted_at"])
      .where("id", "=", report)
      .executeTakeFirstOrThrow();
    expect(skill).toEqual({ owner_org_id: null, deleted_at: null });
    expect(await usable(orgB)).toEqual(expect.arrayContaining(["del-shared", "del-report"]));
    const notices = await env.db
      .selectFrom("platform_notices")
      .select(["kind", "detail"])
      .execute();
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.kind)).toEqual(["ownership_transferred", "ownership_transferred"]);
    expect(notices.map((n) => (n.detail as { ref: unknown }).ref)).toEqual(
      expect.arrayContaining([
        { kind: "plugin", id: shared },
        { kind: "skill", id: report },
      ]),
    );
    for (const n of notices) {
      expect(n.detail).toMatchObject({ reason: "org_deleted", fromOrg: { id: orgX }, usedBy: 1 });
    }

    // the unshared plugin is removed, its extension taken out by the cleanup job
    expect((await itemRow(solo)).deleted_at).not.toBeNull();
    await cleanedUp("del-solo");

    // the deleted org's storage purge leaves the promoted skill's files readable
    await env.k.app.get(StorageService).deleteOrg(orgX);
    const v = await env.db
      .selectFrom("platform_skill_versions")
      .select(["object_prefix"])
      .where("skill_id", "=", report)
      .executeTakeFirstOrThrow();
    expect(v.object_prefix).toBeTruthy();
    const md = await env.k.app.get(StorageService).deployment().get(`${v.object_prefix}SKILL.md`);
    expect(md).not.toBeNull();
    expect(await new Response(md?.body).text()).toContain("name: del-report");
  });

  it("upload confirmed after its org was deleted", async () => {
    const orgX = await newOrg();
    const prepared = await prepare(env.root, orgX, await skillPlugin("del-late"));
    expect((await deleteOrg(orgX)).statusCode).toBe(204);
    const c = await env.root({
      method: "POST",
      url: `${uploads(orgX)}/${prepared.stagingId}/confirm`,
      payload: { reviewHash: prepared.review.reviewHash },
    });
    expect(errorOf(c)).toEqual([404, "org.not_found"]);
    expect(
      await env.db
        .selectFrom("catalog_items")
        .select("id")
        .where("name", "=", "del-late")
        .execute(),
    ).toEqual([]);
  });

  it("pending upload of a deleted org", async () => {
    const orgX = await newOrg();
    const itemId = await uploaded(
      orgX,
      await lifePkg({ name: "del-wait", version: "1.0.0" }),
      "pending",
    );
    expect(await claimOf("del-wait")).toBeDefined();
    const inboxIds = async () =>
      (
        (await env.root({ method: "GET", url: "/api/v1/admin/inbox" })).json() as {
          items: { type: string; item?: { id: string } }[];
        }
      ).items
        .filter((i) => i.type === "org_upload_pending")
        .map((i) => i.item?.id);
    expect(await inboxIds()).toContain(itemId);

    expect((await deleteOrg(orgX)).statusCode).toBe(204);
    expect(await itemRow(itemId)).toMatchObject({ pending_version: null });
    expect((await itemRow(itemId)).deleted_at).not.toBeNull();
    // released in the deletion's transaction (nothing was installed under it, pre-flight F10)
    expect(await claimOf("del-wait")).toBeUndefined();
    expect(await inboxIds()).not.toContain(itemId);
    // another org may take the name now
    const again = await uploaded(
      orgB,
      await lifePkg({ name: "del-wait", version: "1.0.0" }),
      "pending",
    );
    expect(again).not.toBe(itemId);
  });

  it("a transferred plugin's pending new version is cleared", async () => {
    const orgX = await newOrg();
    const itemId = await confirmedIn(orgX, "del-pv");
    await sharedWithB(orgX, itemId, "del-pv-notes");
    const v2 = await uploaded(
      orgX,
      await lifePkg({ name: "del-pv", version: "2.0.0", skills: ["del-pv-notes"] }),
      "pending",
    );
    expect(v2).toBe(itemId);
    expect(await itemRow(itemId)).toMatchObject({ pending_version: "2.0.0" });
    expect((await deleteOrg(orgX)).statusCode).toBe(204);
    expect(await itemRow(itemId)).toEqual({
      deleted_at: null,
      owner_org_id: null,
      awaiting_confirmation: false,
      pending_version: null,
    });
    const item = await env.db
      .selectFrom("catalog_items")
      .select(["pending_by", "pending_at", "platform_synced_version"])
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(item).toEqual({ pending_by: null, pending_at: null, platform_synced_version: "1.0.0" });
    // B keeps the confirmed version; nothing of 2.0.0 is installed
    expect(await usable(orgB)).toContain("del-pv-notes");
    const ext = await env.db
      .selectFrom("extension_installs")
      .select("version")
      .where("name", "=", "del-pv")
      .executeTakeFirstOrThrow();
    expect(ext.version).toBe("1.0.0");
  });

  it("a platform update and the owner org's deletion take their locks in one order", async () => {
    // ruling P3-50: the orgs first, then the item, then its components
    const orgX = await newOrg();
    await enableExtensions(env.db, orgX, "fake-connector");
    const itemId = await seedPlugin(env, {
      name: "del-upd",
      skills: ["upd-notes"],
      templates: { gh: { defaultToolPolicies: { search: "allow", delete_all: "allow" } } },
    });
    await seedPlugin(env, {
      name: "del-upd",
      addTo: itemId,
      version: "2.0.0",
      skills: ["upd-notes"],
      templates: { gh: { defaultToolPolicies: { search: "ask", delete_all: "allow" } } },
    });
    await setScope(env, itemId, "named", [orgX]);
    const ins = await env.root({
      method: "POST",
      url: `/api/v1/orgs/${orgX}/catalog/${itemId}/install`,
      payload: {
        connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } } },
      },
    });
    expect(ins.statusCode, ins.body).toBe(201);
    // org X owns it, at its applied version 2.0.0 (the super admin's generic update reaches it)
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: orgX, latest_version: "2.0.0" })
      .where("id", "=", itemId)
      .execute();
    for (const table of ["platform_skills", "platform_connector_templates"] as const) {
      await env.db
        .updateTable(table as "platform_skills")
        .set({ owner_org_id: orgX })
        .where("catalog_item_id", "=", itemId)
        .execute();
    }
    const p = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "2.0.0" },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect(
      (p.json() as { connectorOrgs: { orgId: string }[] }).connectorOrgs.map((c) => c.orgId),
    ).toEqual([orgX]);
    // the deletion starts while the update holds its rows, and waits on a lock before it goes on
    let deletion: Promise<{ statusCode: number; body: string }> | undefined;
    const original = PlatformComponents.prototype.applySyncIn;
    vi.spyOn(PlatformComponents.prototype, "applySyncIn").mockImplementationOnce(async function (
      this: PlatformComponents,
      ...args
    ) {
      const r = await original.apply(this, args);
      // a request of its own, outside the update's transaction context
      deletion = runOutsideTransaction(() => deleteOrg(orgX));
      await waitFor(
        async () => {
          const row = await sql<{ n: number }>`
              SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND datname = current_database()`.execute(env.db);
          return (row.rows[0]?.n ?? 0) > 0;
        },
        10_000,
        "the deletion waits on a lock",
      );
      return r;
    });
    const u = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/update`,
      payload: { version: "2.0.0", diffHash: p.json().diffHash },
    });
    expect(deletion).toBeDefined();
    const d = await (deletion as Promise<{ statusCode: number; body: string }>);
    // no deadlock (40P01 -> 500) on either side
    expect(u.statusCode, u.body).toBe(200);
    expect(d.statusCode, d.body).toBe(204);
    expect((await itemRow(itemId)).deleted_at).not.toBeNull();
  });

  describe("confirmation racing the removal (P3-21)", () => {
    /** Org X's pending upload `name` and the digest the super admin confirms it with. */
    async function pendingIn(name: string) {
      const orgX = await newOrg();
      const itemId = await uploaded(orgX, await lifePkg({ name, version: "1.0.0" }), "pending");
      return { orgX, itemId, digest: await digestOf(itemId) };
    }

    /** Runs `between` right after the confirmation's install step (pre-flight F28). */
    function afterInstall(between: () => Promise<void>) {
      const ops = env.k.app.get(ExtensionAdminOps);
      const original = ops.install.bind(ops);
      const spy = vi.spyOn(ops, "install").mockImplementationOnce(async (...args) => {
        const r = await original(...args);
        // a request of its own, outside any transaction context of the confirmation
        await runOutsideTransaction(between);
        return r;
      });
      return spy;
    }

    it("confirmation racing the deletion", async () => {
      const { orgX, itemId, digest } = await pendingIn("del-race");
      const spy = afterInstall(async () => {
        expect((await deleteOrg(orgX)).statusCode).toBe(204);
        // installed under its claim: the deletion leaves the claim to the take-out (F10)
        expect(await claimOf("del-race")).toBeDefined();
      });
      const c = await confirmUpload(itemId, digest);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(errorOf(c)).toEqual([409, "catalog.item_removed"]);
      expect((await itemRow(itemId)).deleted_at).not.toBeNull();
      await cleanedUp("del-race");
    });

    it("confirmation racing the owner's delete", async () => {
      const { orgX, itemId, digest } = await pendingIn("del-race-own");
      const p = await env.root({ method: "POST", url: `${owned(orgX, itemId)}/delete/preview` });
      expect(p.statusCode, p.body).toBe(200);
      expect(p.json()).toMatchObject({ outcome: "removed" });
      afterInstall(async () => {
        const d = await env.root({
          method: "POST",
          url: `${owned(orgX, itemId)}/delete`,
          payload: { previewHash: p.json().previewHash },
        });
        expect(d.statusCode, d.body).toBe(204);
      });
      const c = await confirmUpload(itemId, digest);
      expect(errorOf(c)).toEqual([409, "catalog.item_removed"]);
      expect((await itemRow(itemId)).deleted_at).not.toBeNull();
      await cleanedUp("del-race-own");
    });

    it("a confirmation and a deletion sent together leave nothing installed", async () => {
      const { orgX, itemId, digest } = await pendingIn("del-race-both");
      const [c, d] = await Promise.all([confirmUpload(itemId, digest), deleteOrg(orgX)]);
      expect(d.statusCode, d.body).toBe(204);
      // either the confirmation won (then the deletion removed the confirmed plugin) or it saw
      // the removal
      if (c.statusCode !== 200) expect(errorOf(c)).toEqual([409, "catalog.item_removed"]);
      expect((await itemRow(itemId)).deleted_at).not.toBeNull();
      await cleanedUp("del-race-both");
      expect(
        await env.db
          .selectFrom("plugin_installs")
          .select("id")
          .where("item_id", "=", itemId)
          .where("org_id", "!=", orgX)
          .execute(),
      ).toEqual([]);
    });
  });
});
