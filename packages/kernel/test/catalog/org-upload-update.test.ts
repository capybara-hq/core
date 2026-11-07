import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import { PlatformPluginUpdater } from "../../src/catalog/plugin-upgrade.js";
import { ExtensionAdminOps } from "../../src/extensions/admin-ops.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { usableSkills } from "../../src/skills/usable.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, type Req, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { importPlugin, type OrgEnv, resetOrgCatalog, setScope, startOrgEnv } from "./org-env.js";
import { bundlePlugin, skillPlugin } from "./packages.js";

/**
 * Plugin scope phase 3, Task 5 (spec §14, P3-12, P3-12', pre-flight F3 to F7): a new version of an
 * org's own plugin without an extension applies at once through the platform updater acting for
 * the owner org. The org's review carries the update preview and one hash covers both; the orgs
 * using a shared plugin are told (`shared_item_updated`); a version that drops the extension
 * uninstalls it; a failed update leaves the version imported and uploading it again retries.
 */

let env: OrgEnv;
/** Org A ("Acme"; boss is its admin). */
let orgA: string;
/** Org B ("B"; root is its owner). */
let orgB: string;

beforeAll(async () => {
  env = await startOrgEnv();
  orgA = env.orgId;
  orgB = await createOrg(env.root, "B");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("org_notices").execute();
});

const base = (orgId: string) => `/api/v1/orgs/${orgId}/catalog/uploads`;

interface Prepared {
  stagingId: string;
  review: { name: string; version: string; reviewHash: string };
  update: {
    from: string | null;
    to: string;
    components: { kind: string; name: string; change: string }[];
    extension: { from: string | null; to: string | null } | null;
    diffHash: string;
  } | null;
}

async function prepared(req: Req, orgId: string, bytes: Uint8Array): Promise<Prepared> {
  const r = await req({
    method: "POST",
    url: `${base(orgId)}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Prepared;
}

const confirm = (req: Req, orgId: string, p: Prepared, body: Record<string, unknown> = {}) =>
  req({
    method: "POST",
    url: `${base(orgId)}/${p.stagingId}/confirm`,
    payload: { reviewHash: p.review.reviewHash, ...body },
  });

const itemRow = (name: string) =>
  env.db
    .selectFrom("catalog_items")
    .selectAll()
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();

const installRow = (name: string) =>
  env.db
    .selectFrom("extension_installs")
    .select(["sha256", "version", "desired_state"])
    .where("name", "=", name)
    .executeTakeFirst();

/** The `extension.*` audit rows of an extension written by org A's admin, oldest first. */
async function extensionAudits(name: string) {
  const rows = await env.db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail"])
    .where("target", "=", name)
    .where("action", "like", "extension.%")
    .where("actor_account_id", "=", env.bossId)
    .orderBy("at")
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    action: r.action,
    actor: r.actor_account_id,
    ownerOrgId: (r.detail as { ownerOrgId?: string }).ownerOrgId,
  }));
}

/** Makes an item imported by the super admin org A's own (pre-flight F6). */
async function ownedByA(itemId: string): Promise<void> {
  await env.db
    .updateTable("catalog_items")
    .set({ owner_org_id: orgA, shareable: false, shown_to_others: false })
    .where("id", "=", itemId)
    .execute();
  await setScope(env, itemId, "named", [orgA]);
}

const usable = async (orgId: string) => (await usableSkills(env.db, orgId)).map((s) => s.name);

/** Org A uploads `crm` 1.0.0 (skill `crm-notes`), shareable, and shares it with org B (on there). */
async function sharedCrm(): Promise<string> {
  const p = await prepared(env.boss, orgA, await skillPlugin("crm", { skill: "crm-notes" }));
  const c = await confirm(env.boss, orgA, p, { shareable: true });
  expect(c.statusCode, c.body).toBe(201);
  const itemId = (c.json() as { item: { id: string } }).item.id;
  await setScope(env, itemId, "named", [orgA, orgB]);
  await env.db
    .updateTable("catalog_items")
    .set({ shown_to_others: true })
    .where("id", "=", itemId)
    .execute();
  await env.k.app.get(CatalogScopeService).enqueueSync(itemId);
  await waitFor(
    async () => (await usable(orgB)).includes("crm-notes"),
    15_000,
    "crm-notes usable in org B",
  );
  return itemId;
}

describe("owner updates without an extension", { timeout: 120_000 }, () => {
  it("owner update applies at once and reaches every org", async () => {
    const itemId = await sharedCrm();
    const v2 = await bundlePlugin({
      name: "crm",
      version: "2.0.0",
      skills: ["crm-notes", "crm-extra"],
    });
    const p = await prepared(env.boss, orgA, v2);
    expect(p.update).not.toBeNull();
    expect(p.update).toMatchObject({ from: "1.0.0", to: "2.0.0", extension: null });
    expect(p.update?.components).toContainEqual(
      expect.objectContaining({ kind: "skill", name: "crm-extra", change: "added" }),
    );
    const c = await confirm(env.boss, orgA, p);
    expect(c.statusCode, c.body).toBe(201);
    expect((c.json() as { outcome: string }).outcome).toBe("updated");
    expect((await itemRow("crm")).platform_synced_version).toBe("2.0.0");
    await waitFor(
      async () =>
        (await usable(orgA)).includes("crm-extra") && (await usable(orgB)).includes("crm-extra"),
      15_000,
      "crm-extra usable in A and B",
    );
    const notices = await env.db
      .selectFrom("org_notices")
      .select(["org_id", "kind", "detail"])
      .execute();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      org_id: orgB,
      kind: "shared_item_updated",
      detail: { ref: { kind: "plugin", id: itemId }, name: "crm", from: "1.0.0", to: "2.0.0" },
    });
  });

  it("the review hash covers the update preview", async () => {
    await sharedCrm();
    const p = await prepared(
      env.boss,
      orgA,
      await bundlePlugin({ name: "crm", version: "2.0.0", skills: ["crm-notes", "crm-extra"] }),
    );
    // the staged review is the same through GET, with the same combined hash
    const g = await env.boss({ method: "GET", url: `${base(orgA)}/${p.stagingId}` });
    expect(g.statusCode, g.body).toBe(200);
    expect((g.json() as Prepared).review.reviewHash).toBe(p.review.reviewHash);
    expect((g.json() as Prepared).update?.diffHash).toBe(p.update?.diffHash);
    const bad = await confirm(env.boss, orgA, p, { reviewHash: "0".repeat(32) });
    expect(bad.statusCode, bad.body).toBe(409);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("plugin.review_stale");
    expect((await itemRow("crm")).latest_version).toBe("1.0.0");
  });

  it("a version dropping the extension applies at once", async () => {
    // v1 with an extension, seeded as a super admin import, then owned by org A (pre-flight F6)
    const itemId = await importPlugin(env, await lifePkg({ name: "own-ext", version: "1.0.0" }));
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: orgA, shareable: false, shown_to_others: false })
      .where("id", "=", itemId)
      .execute();
    await setScope(env, itemId, "named", [orgA]);
    expect(
      await env.db
        .selectFrom("extension_installs")
        .select("name")
        .where("name", "=", "own-ext")
        .executeTakeFirst(),
    ).toBeDefined();
    const v2 = await pluginTgz({
      manifest: { name: "own-ext", version: "2.0.0", skills: [{ path: "./skills/own-notes" }] },
      files: { "skills/own-notes/SKILL.md": SKILL_MD("own-notes") },
    });
    const p = await prepared(env.boss, orgA, v2);
    expect(p.update?.extension).toMatchObject({ from: "1.0.0", to: null });
    const c = await confirm(env.boss, orgA, p);
    expect(c.statusCode, c.body).toBe(201);
    expect((c.json() as { outcome: string }).outcome).toBe("updated");
    expect((await itemRow("own-ext")).platform_synced_version).toBe("2.0.0");
    expect(
      await env.db
        .selectFrom("extension_installs")
        .select("name")
        .where("name", "=", "own-ext")
        .executeTakeFirst(),
    ).toBeUndefined();
    // the extension steps are audited as the org admin acting for the owner org
    expect(await extensionAudits("own-ext")).toEqual([
      { action: "extension.disabled", actor: env.bossId, ownerOrgId: orgA },
      { action: "extension.uninstalled", actor: env.bossId, ownerOrgId: orgA },
    ]);
  });

  it("the owner's preview names the other orgs it mentions (orgNames)", async () => {
    const itemId = await importPlugin(
      env,
      await lifePkg({ name: "own-names", version: "1.0.0", skills: ["names-notes"] }),
    );
    await env.db
      .updateTable("catalog_items")
      .set({ owner_org_id: orgA, shareable: true, shown_to_others: false })
      .where("id", "=", itemId)
      .execute();
    await setScope(env, itemId, "named", [orgA, orgB]);
    // a new scope version, so this sync is not deduplicated against the import's own sync job
    // (`scope-item-<id>-<v>`) still running; then the full convergence: live installs in A and B
    await env.db
      .updateTable("catalog_items")
      .set({ scope_version: sql<number>`scope_version + 1` })
      .where("id", "=", itemId)
      .execute();
    await env.k.app.get(CatalogScopeService).enqueueSync(itemId);
    await waitFor(
      async () =>
        (
          await env.db
            .selectFrom("plugin_installs")
            .select("org_id")
            .where("item_id", "=", itemId)
            .where("status", "=", "installed")
            .execute()
        ).length === 2,
      30_000,
      "own-names installed in orgs A and B",
    );
    const v2 = await pluginTgz({
      manifest: { name: "own-names", version: "2.0.0", skills: [{ path: "./skills/names-notes" }] },
      files: { "skills/names-notes/SKILL.md": SKILL_MD("names-notes") },
    });
    const p = (await prepared(env.boss, orgA, v2)) as Prepared & {
      update: { extension: { orgs: string[] } | null; orgNames?: Record<string, string> };
    };
    expect(p.update?.extension?.orgs).toContain(orgB);
    // an org admin cannot read other orgs: the kernel names them (P3-19, P3-14)
    expect(p.update?.orgNames).toEqual({ [orgA]: "Acme", [orgB]: "B" });
  });

  it("a failed update that removed the extension puts it back as it was", async () => {
    const itemId = await importPlugin(env, await lifePkg({ name: "own-rb", version: "1.0.0" }));
    await ownedByA(itemId);
    const before = await installRow("own-rb");
    expect(before).toMatchObject({ desired_state: "enabled" });
    const v2 = await pluginTgz({
      manifest: { name: "own-rb", version: "2.0.0", skills: [{ path: "./skills/rb-notes" }] },
      files: { "skills/rb-notes/SKILL.md": SKILL_MD("rb-notes") },
    });
    const p = await prepared(env.boss, orgA, v2);
    expect(p.update?.extension).toMatchObject({ from: "1.0.0", to: null });
    // the commit fails after the extension was disabled and uninstalled
    vi.spyOn(PlatformComponents.prototype, "applySyncIn").mockRejectedValueOnce(
      new Error("injected sync failure"),
    );
    const c = await confirm(env.boss, orgA, p);
    expect(c.statusCode, c.body).toBe(502);
    expect(
      (c.json() as { error: { code: string; details: unknown[] } }).error.details[0],
    ).toMatchObject({ step: "components", rolledBack: true });
    // back at its package and state; the item still at 1.0.0 (2.0.0 imported)
    expect(await installRow("own-rb")).toEqual(before);
    expect(await itemRow("own-rb")).toMatchObject({
      platform_synced_version: "1.0.0",
      // never applied: not the item's latest (ruling P3-34)
      latest_version: "1.0.0",
    });
    expect(await extensionAudits("own-rb")).toEqual([
      { action: "extension.disabled", actor: env.bossId, ownerOrgId: orgA },
      { action: "extension.uninstalled", actor: env.bossId, ownerOrgId: orgA },
      { action: "extension.installed", actor: env.bossId, ownerOrgId: orgA },
      { action: "extension.enabled", actor: env.bossId, ownerOrgId: orgA },
    ]);
  });

  it("the put-back runs even when the admin was demoted during the update", async () => {
    const itemId = await importPlugin(env, await lifePkg({ name: "own-demote", version: "1.0.0" }));
    await ownedByA(itemId);
    const before = await installRow("own-demote");
    const v2 = await pluginTgz({
      manifest: { name: "own-demote", version: "2.0.0", skills: [{ path: "./skills/dm-notes" }] },
      files: { "skills/dm-notes/SKILL.md": SKILL_MD("dm-notes") },
    });
    const p = await prepared(env.boss, orgA, v2);
    // boss is demoted once the extension is uninstalled: the commit's re-check refuses
    const ops = env.k.app.get(ExtensionAdminOps);
    const real = ops.uninstall.bind(ops);
    vi.spyOn(ops, "uninstall").mockImplementationOnce(async (...args) => {
      await real(...args);
      await env.db
        .updateTable("memberships")
        .set({ role: "member" })
        .where("org_id", "=", orgA)
        .where("account_id", "=", env.bossId)
        .execute();
    });
    try {
      const c = await confirm(env.boss, orgA, p);
      expect(c.statusCode, c.body).toBe(403);
    } finally {
      await env.db
        .updateTable("memberships")
        .set({ role: "admin" })
        .where("org_id", "=", orgA)
        .where("account_id", "=", env.bossId)
        .execute();
    }
    expect(await installRow("own-demote")).toEqual(before);
    expect((await itemRow("own-demote")).platform_synced_version).toBe("1.0.0");
    const failed = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.platform_update_failed")
      .where("target", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(failed.detail).toMatchObject({ step: "components", rolledBack: true });
    // the put-back keeps the actor, marked as a rollback
    const rows = await env.db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "detail"])
      .where("target", "=", "own-demote")
      .where("action", "in", ["extension.installed", "extension.enabled"])
      .where("actor_account_id", "=", env.bossId)
      .orderBy("at")
      .execute();
    expect(rows.map((r) => [r.action, (r.detail as { rollback?: boolean }).rollback])).toEqual([
      ["extension.installed", true],
      ["extension.enabled", true],
    ]);
  });

  it("the owner moves its plugin to a lower version (ruling P3-30)", async () => {
    const itemId = await sharedCrm();
    const v2 = await skillPlugin("crm", {
      skill: "crm-notes",
      version: "2.0.0",
      skillMd: SKILL_MD("crm-notes", "Updated notes."),
    });
    const up = await prepared(env.boss, orgA, v2);
    expect((await confirm(env.boss, orgA, up)).statusCode).toBe(201);
    expect((await itemRow("crm")).platform_synced_version).toBe("2.0.0");
    // the 1.0.0 tgz again: the review shows the downgrade, the confirm applies it
    const down = await prepared(env.boss, orgA, await skillPlugin("crm", { skill: "crm-notes" }));
    expect(down.review.version).toBe("1.0.0");
    expect(down.update).toMatchObject({ from: "2.0.0", to: "1.0.0" });
    expect(down.update?.components).toContainEqual(
      expect.objectContaining({ kind: "skill", name: "crm-notes", change: "downgrade" }),
    );
    const c = await confirm(env.boss, orgA, down);
    expect(c.statusCode, c.body).toBe(201);
    expect((c.json() as { outcome: string }).outcome).toBe("updated");
    expect((await itemRow("crm")).platform_synced_version).toBe("1.0.0");
    const notices = await env.db
      .selectFrom("org_notices")
      .select(["org_id", "detail"])
      .where("kind", "=", "shared_item_updated")
      .execute();
    expect(notices.map((n) => [n.org_id, (n.detail as { to: string }).to])).toEqual([
      [orgB, "2.0.0"],
      [orgB, "1.0.0"],
    ]);
    expect(itemId).toBeTruthy();
  });

  it("a no-extension upload clears a pending version (pre-flight F7)", async () => {
    const itemId = await sharedCrm();
    await env.db
      .updateTable("catalog_items")
      .set({ pending_version: "1.5.0", pending_by: env.bossId, pending_at: new Date() })
      .where("id", "=", itemId)
      .execute();
    const p = await prepared(
      env.boss,
      orgA,
      await bundlePlugin({ name: "crm", version: "2.0.0", skills: ["crm-notes"] }),
    );
    const c = await confirm(env.boss, orgA, p);
    expect(c.statusCode, c.body).toBe(201);
    expect(await itemRow("crm")).toMatchObject({
      platform_synced_version: "2.0.0",
      pending_version: null,
      pending_by: null,
      pending_at: null,
    });
  });

  it("a failed update retries on re-upload", async () => {
    await sharedCrm();
    const v2 = await bundlePlugin({
      name: "crm",
      version: "2.0.0",
      skills: ["crm-notes", "clash"],
    });
    const p = await prepared(env.boss, orgA, v2);
    // org B takes the skill name `clash` after the review, before the update runs (rule 10, P2-3)
    const updater = env.k.app.get(PlatformPluginUpdater);
    const real = updater.updateAsOwner.bind(updater);
    let clashId = "";
    vi.spyOn(updater, "updateAsOwner").mockImplementationOnce(async (...args) => {
      const md = new TextEncoder().encode(SKILL_MD("clash"));
      const own = await env.k.app.get(SkillsService).createVersionFromFiles(orgB, env.rootId, {
        name: "clash",
        description: "Mine.",
        files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
      });
      clashId = own.skill.id;
      return real(...args);
    });
    const failed = await confirm(env.boss, orgA, p);
    expect(failed.statusCode, failed.body).toBe(409);
    expect((failed.json() as { error: { code: string } }).error.code).toBe("plugin.skill_conflict");
    // the version is imported but not applied: latest and platform still at 1.0.0 (P3-34)
    expect(await itemRow("crm")).toMatchObject({
      latest_version: "1.0.0",
      platform_synced_version: "1.0.0",
    });
    expect(await usable(orgA)).not.toContain("clash");
    // the clash removed, the same tgz again: an update-only review whose confirm retries
    await env.db
      .updateTable("skills")
      .set({ deleted_at: new Date() })
      .where("id", "=", clashId)
      .execute();
    const again = await prepared(env.boss, orgA, v2);
    expect(again.review.version).toBe("2.0.0");
    expect(again.update).toMatchObject({ from: "1.0.0", to: "2.0.0" });
    const ok = await confirm(env.boss, orgA, again);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((ok.json() as { outcome: string }).outcome).toBe("updated");
    expect((await itemRow("crm")).platform_synced_version).toBe("2.0.0");
    const versions = await env.db
      .selectFrom("catalog_item_versions as v")
      .innerJoin("catalog_items as i", "i.id", "v.item_id")
      .select("v.version")
      .where("i.name", "=", "crm")
      .execute();
    expect(versions.map((v) => v.version).sort()).toEqual(["1.0.0", "2.0.0"]);
    // once applied, the same tgz is an imported version again
    const r = await env.boss({
      method: "POST",
      url: `${base(orgA)}/file`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(v2),
    });
    expect(r.statusCode, r.body).toBe(409);
    expect((r.json() as { error: { code: string } }).error.code).toBe("catalog.version_exists");
  });

  it("previewForOwner and updateAsOwner act only for the owner org", async () => {
    const itemId = await sharedCrm();
    await prepared(
      env.boss,
      orgA,
      await bundlePlugin({ name: "crm", version: "2.0.0", skills: ["crm-notes"] }),
    );
    const updater = env.k.app.get(PlatformPluginUpdater);
    await expect(updater.previewForOwner(orgB, itemId, "1.0.0")).rejects.toMatchObject({
      code: "catalog.item_not_found",
    });
    // a member of the owner org is not its admin
    await expect(
      updater.updateAsOwner(orgA, env.memId, itemId, "1.0.0", "x"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
