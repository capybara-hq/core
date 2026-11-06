import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import { PlatformPluginUpdater } from "../../src/catalog/plugin-upgrade.js";
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
    // the version is imported, the platform still at 1.0.0
    expect(await itemRow("crm")).toMatchObject({
      latest_version: "2.0.0",
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
