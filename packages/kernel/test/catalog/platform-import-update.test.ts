import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { importPlugin, install, type OrgEnv, resetOrgCatalog, startOrgEnv } from "./org-env.js";

/**
 * The platform's update of an installed plugin to a version staged for import (the one 更新到
 * wizard, maintainer decision 2026-11-13, `PlatformImportUpdate`): the import review and the
 * update preview of the staged version are confirmed together; nothing is written before that
 * confirm, and an update failing after the import leaves the platform where it was with the
 * version imported, saying so.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const loaded = (name: string) => env.k.app.get(ExtensionHost).current(name)?.manifest.version;
const extensionRow = (name: string) =>
  env.db
    .selectFrom("extension_installs")
    .select(["sha256", "version"])
    .where("name", "=", name)
    .executeTakeFirst();
const snapshotVersion = async (name: string) =>
  (
    await env.db
      .selectFrom("extension_permission_snapshots")
      .select("version")
      .where("plugin", "=", name)
      .executeTakeFirst()
  )?.version;
const itemRow = (itemId: string) =>
  env.db
    .selectFrom("catalog_items")
    .select(["platform_synced_version", "latest_version"])
    .where("id", "=", itemId)
    .executeTakeFirstOrThrow();
const versionsOf = async (itemId: string) =>
  (
    await env.db
      .selectFrom("catalog_item_versions")
      .select("version")
      .where("item_id", "=", itemId)
      .orderBy("version")
      .execute()
  ).map((v) => v.version);
const stagingExists = async (stagingId: string) =>
  (await env.db
    .selectFrom("plugin_import_staging")
    .select("id")
    .where("id", "=", stagingId)
    .executeTakeFirst()) !== undefined;

/** Prepares the import of `bytes`: `{ stagingId, reviewHash }`. */
async function stage(bytes: Uint8Array): Promise<{ stagingId: string; reviewHash: string }> {
  const r = await env.root({
    method: "POST",
    url: "/api/v1/admin/catalog/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(r.statusCode, r.body).toBe(200);
  return { stagingId: r.json().stagingId, reviewHash: r.json().review.reviewHash };
}

const previewReq = (stagingId: string, req = env.root) =>
  req({ method: "GET", url: `/api/v1/admin/catalog/imports/${stagingId}/update-preview` });

async function previewOk(stagingId: string): Promise<PlatformUpdatePreview> {
  const r = await previewReq(stagingId);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as PlatformUpdatePreview;
}

const confirm = (stagingId: string, body: Record<string, unknown>, req = env.root) =>
  req({ method: "POST", url: `/api/v1/admin/catalog/imports/${stagingId}/update`, payload: body });

/** An installed plugin `name` at 1.0.0 with its extension loaded, on in the test org. */
async function installed(name: string): Promise<string> {
  const item = await importPlugin(env, await lifePkg({ name, version: "1.0.0" }));
  await waitFor(async () => loaded(name) === "1.0.0", 15_000, "1.0.0 loaded");
  const r = await install(env.boss, env, item);
  expect(r.statusCode, r.body).toBe(201);
  return item;
}

describe("platform import and update (one wizard)", { timeout: 180_000 }, () => {
  it("the preview of a staged version writes nothing; the confirm imports it and updates the platform, extension included", async () => {
    const item = await installed("iu-ok");
    const v2 = await lifePkg({ name: "iu-ok", version: "2.0.0", skills: ["notes"] });
    const st = await stage(v2);
    const p = await previewOk(st.stagingId);
    expect(p).toMatchObject({ itemId: item, from: "1.0.0", to: "2.0.0" });
    expect(p.extension).toMatchObject({ from: "1.0.0", to: "2.0.0", needsApproval: false });
    expect(p.components).toContainEqual(
      expect.objectContaining({ kind: "skill", name: "notes", change: "added" }),
    );
    // Cancelling here changes nothing: no version, the extension and platform as they were
    expect(await versionsOf(item)).toEqual(["1.0.0"]);
    expect(await extensionRow("iu-ok")).toMatchObject({ version: "1.0.0" });
    expect(await itemRow(item)).toMatchObject({ platform_synced_version: "1.0.0" });

    const r = await confirm(st.stagingId, { reviewHash: st.reviewHash, diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().update).toMatchObject({ version: "2.0.0" });
    expect(r.json().item).toMatchObject({ id: item, latestVersion: "2.0.0" });
    expect(await versionsOf(item)).toEqual(["1.0.0", "2.0.0"]);
    expect(await extensionRow("iu-ok")).toMatchObject({ sha256: sha(v2), version: "2.0.0" });
    expect(await itemRow(item)).toMatchObject({ platform_synced_version: "2.0.0" });
    expect(await snapshotVersion("iu-ok")).toBe("2.0.0");
    await waitFor(async () => loaded("iu-ok") === "2.0.0", 15_000, "2.0.0 loaded");
    expect(await stagingExists(st.stagingId)).toBe(false);
  });

  it("a stale diffHash or reviewHash is refused and nothing is imported", async () => {
    const item = await installed("iu-stale");
    const st = await stage(await lifePkg({ name: "iu-stale", version: "2.0.0" }));
    const p = await previewOk(st.stagingId);
    const staleDiff = await confirm(st.stagingId, {
      reviewHash: st.reviewHash,
      diffHash: "0".repeat(64),
    });
    expect(staleDiff.statusCode, staleDiff.body).toBe(409);
    expect(staleDiff.json().error.code).toBe("plugin.upgrade_stale");
    const staleReview = await confirm(st.stagingId, {
      reviewHash: "0".repeat(32),
      diffHash: p.diffHash,
    });
    expect(staleReview.statusCode, staleReview.body).toBe(409);
    expect(staleReview.json().error.code).toBe("plugin.review_stale");
    expect(await versionsOf(item)).toEqual(["1.0.0"]);
    expect(await extensionRow("iu-stale")).toMatchObject({ version: "1.0.0" });
    expect(await stagingExists(st.stagingId)).toBe(true);
    // the same staging still confirms
    const ok = await confirm(st.stagingId, { reviewHash: st.reviewHash, diffHash: p.diffHash });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("an update failing after the import: the platform and the extension stay, the approval is put back, the version stays imported and a plain update retries", async () => {
    const item = await installed("iu-fail");
    // 2.0.0 asks for more permissions (a policy hook), so its approval differs from 1.0.0's
    const v2 = await lifePkg({ name: "iu-fail", version: "2.0.0", policy: true });
    const st = await stage(v2);
    const p = await previewOk(st.stagingId);
    vi.spyOn(PlatformComponents.prototype, "applySyncIn").mockRejectedValueOnce(
      new Error("injected sync failure"),
    );
    const r = await confirm(st.stagingId, { reviewHash: st.reviewHash, diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("plugin.imported_not_updated");
    expect(r.json().error.details[0]).toMatchObject({
      version: "2.0.0",
      from: "1.0.0",
      code: "plugin.upgrade_failed",
      approvalRestored: true,
    });
    expect(await versionsOf(item)).toEqual(["1.0.0", "2.0.0"]);
    expect(await extensionRow("iu-fail")).toMatchObject({ version: "1.0.0" });
    expect(await itemRow(item)).toMatchObject({ platform_synced_version: "1.0.0" });
    expect(await snapshotVersion("iu-fail")).toBe("1.0.0");
    vi.restoreAllMocks();
    // the imported version is updated to with the plain update preview
    const again = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${item}/update/preview`,
      payload: { version: "2.0.0" },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().extension).toMatchObject({ from: "1.0.0", to: "2.0.0" });
    const done = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${item}/update`,
      payload: { version: "2.0.0", diffHash: again.json().diffHash },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await itemRow(item)).toMatchObject({ platform_synced_version: "2.0.0" });
  });

  it("a plugin not installed yet is the install review's: 409 not_installed; only super admins", async () => {
    const st = await stage(
      await pluginTgz({
        manifest: { name: "iu-new", version: "1.0.0", skills: [{ path: "./skills/notes" }] },
        files: { "skills/notes/SKILL.md": SKILL_MD("notes") },
      }),
    );
    const r = await previewReq(st.stagingId);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "plugin.upgrade_target_invalid",
      details: [{ reason: "not_installed" }],
    });
    const c = await confirm(st.stagingId, { reviewHash: st.reviewHash, diffHash: "x" });
    expect(c.statusCode, c.body).toBe(409);
    expect(await stagingExists(st.stagingId)).toBe(true);
    const boss = await previewReq(st.stagingId, env.boss);
    expect(boss.statusCode).toBe(403);
  });
});
