import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import { OwnedPluginCleanup } from "../../src/catalog/owned-plugin-cleanup.js";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import { PlatformMigration } from "../../src/catalog/platform-migration.js";
import {
  PLUGIN_SCOPE_QUEUE,
  PluginScopeSync,
  SCOPE_LOAD_RETRIES,
  scopeRetryJobId,
} from "../../src/catalog/scope-sync.js";
import { ExtensionAdmin } from "../../src/extensions/admin-view.js";
import { ExtensionInstalls } from "../../src/extensions/installs.js";
import { PluginInstallLock } from "../../src/extensions/locks.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { usableSkills } from "../../src/skills/usable.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, type Req, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { importPlugin, type OrgEnv, resetOrgCatalog, setScope, startOrgEnv } from "./org-env.js";
import { bundlePlugin } from "./packages.js";

/**
 * Plugin scope phase 3, Task 6 (spec §14, P3-9 to P3-11, P3-13, P3-21, P3-22; pre-flight F7, F8,
 * F10, F11, F12): an org upload carrying an extension stays pending until the super admin confirms
 * that exact version's digest. Nothing of it runs or is usable before: no install, no platform
 * components, no scope sync install, no dependency target. Every later version with an extension
 * waits again; a re-upload replaces the pending version (the old digest is stale); the super admin
 * may reject, the owner may withdraw.
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
  review: { name: string; version: string; reviewHash: string; extension?: unknown };
  update: unknown;
}

const errorOf = (r: { statusCode: number; body: string }) =>
  [r.statusCode, (JSON.parse(r.body) as { error?: { code: string } }).error?.code] as const;

const upload = (req: Req, orgId: string, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: `${base(orgId)}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });

async function prepared(req: Req, orgId: string, bytes: Uint8Array): Promise<Prepared> {
  const r = await upload(req, orgId, bytes);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Prepared;
}

const confirm = (req: Req, orgId: string, p: Prepared, body: Record<string, unknown> = {}) =>
  req({
    method: "POST",
    url: `${base(orgId)}/${p.stagingId}/confirm`,
    payload: { reviewHash: p.review.reviewHash, ...body },
  });

/** Uploads and confirms in the org; returns the item id after asserting the outcome. */
async function uploaded(
  req: Req,
  orgId: string,
  bytes: Uint8Array,
  outcome: "pending" | "installed" | "updated",
): Promise<string> {
  const p = await prepared(req, orgId, bytes);
  const c = await confirm(req, orgId, p);
  expect(c.statusCode, c.body).toBe(201);
  expect((c.json() as { outcome: string }).outcome).toBe(outcome);
  return (c.json() as { item: { id: string } }).item.id;
}

const itemRow = (name: string) =>
  env.db
    .selectFrom("catalog_items")
    .selectAll()
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

const installRow = (name: string) =>
  env.db
    .selectFrom("extension_installs")
    .select(["sha256", "version", "desired_state"])
    .where("name", "=", name)
    .executeTakeFirst();

const versionSha = async (itemId: string, version: string) =>
  (
    await env.db
      .selectFrom("catalog_item_versions")
      .select("extension_sha256")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirstOrThrow()
  ).extension_sha256;

const usable = async (orgId: string) => (await usableSkills(env.db, orgId)).map((s) => s.name);

const loaded = (name: string) =>
  env.k.app
    .get(ExtensionRegistry)
    .manifests()
    .some((m) => m.name === name);

const imported = (name: string, version: string) =>
  ((globalThis as { __lifeImports?: string[] }).__lifeImports ?? []).includes(`${name} ${version}`);

interface AdminItem {
  id: string;
  name: string;
  pending: boolean;
  permissionsHash: string | null;
  owner: unknown;
  pendingVersion: string | null;
  awaitingConfirmation: boolean;
}

/** The super admin's pending list (`GET admin/catalog/items?pending=true`). */
async function pendingItems(): Promise<AdminItem[]> {
  const r = await env.root({ method: "GET", url: "/api/v1/admin/catalog/items?pending=true" });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: AdminItem[] }).items;
}

async function digestOf(itemId: string): Promise<string> {
  const item = (await pendingItems()).find((i) => i.id === itemId);
  expect(item?.permissionsHash).toBeTruthy();
  return item?.permissionsHash as string;
}

const superConfirm = (itemId: string, permissionsHash: string) =>
  env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/confirm`,
    payload: { permissionsHash },
  });

const reject = (itemId: string, reason?: string) =>
  env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/reject`,
    payload: reason === undefined ? {} : { reason },
  });

const withdraw = (req: Req, orgId: string, itemId: string) =>
  req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/owned-plugins/${itemId}/pending` });

const notices = (orgId: string) =>
  env.db
    .selectFrom("org_notices")
    .select(["kind", "detail"])
    .where("org_id", "=", orgId)
    .orderBy("created_at")
    .execute();

/** Org A uploads `name` 1.0.0 (extension + skill `<name>-notes`), the super admin confirms it. */
async function confirmedV1(name: string): Promise<string> {
  const itemId = await uploaded(
    env.boss,
    orgA,
    await lifePkg({ name, version: "1.0.0", skills: [`${name}-notes`] }),
    "pending",
  );
  const c = await superConfirm(itemId, await digestOf(itemId));
  expect(c.statusCode, c.body).toBe(200);
  await waitFor(
    async () => (await usable(orgA)).includes(`${name}-notes`),
    30_000,
    `${name}-notes usable in A`,
  );
  return itemId;
}

/** Shares a confirmed item of org A with org B, where it is then on. */
async function sharedWithB(itemId: string, skill: string): Promise<void> {
  await env.db
    .updateTable("catalog_items")
    .set({ shareable: true, shown_to_others: true })
    .where("id", "=", itemId)
    .execute();
  await env.db
    .updateTable("platform_skills")
    .set({ shareable: true })
    .where("catalog_item_id", "=", itemId)
    .execute();
  await setScope(env, itemId, "named", [orgA, orgB]);
  // a new scope version: the sync job of the confirm may still run under the old one's id
  await env.db
    .updateTable("catalog_items")
    .set({ scope_version: sql<number>`scope_version + 1` })
    .where("id", "=", itemId)
    .execute();
  await env.k.app
    .get(TransactionHost)
    .run(() => env.k.app.get(CatalogScopeService).enqueueSync(itemId));
  await waitFor(async () => (await usable(orgB)).includes(skill), 30_000, `${skill} usable in B`);
}

describe("org uploads with an extension", { timeout: 180_000 }, () => {
  it("first version stays pending and unusable", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-a", version: "1.0.0", skills: ["ext-a-notes"] }),
      "pending",
    );
    expect(await itemRow("ext-a")).toMatchObject({
      id: itemId,
      owner_org_id: orgA,
      awaiting_confirmation: true,
      pending_version: "1.0.0",
      pending_by: env.bossId,
      platform_synced_version: null,
    });
    expect((await itemRow("ext-a"))?.pending_at).not.toBeNull();
    // the package is stored and the name claimed; nothing installed, approved or loaded
    expect(await versionSha(itemId, "1.0.0")).toMatch(/^[0-9a-f]{64}$/);
    expect(await installRow("ext-a")).toBeUndefined();
    expect(
      await env.db
        .selectFrom("extension_name_owners")
        .select("package_name")
        .where("name", "=", "ext-a")
        .executeTakeFirst(),
    ).toEqual({ package_name: "@test/plugin-ext-a" });
    expect(
      await env.db
        .selectFrom("extension_permission_snapshots")
        .select("plugin")
        .where("plugin", "=", "ext-a")
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(loaded("ext-a")).toBe(false);
    expect(imported("ext-a", "1.0.0")).toBe(false);
    // no platform components, nothing usable; the scope sync and the migration job change nothing
    const comps = () =>
      env.db
        .selectFrom("platform_skills")
        .select("id")
        .where("catalog_item_id", "=", itemId)
        .execute();
    expect(await comps()).toEqual([]);
    await env.k.app.get(PluginScopeSync).process({ kind: "item", itemId });
    await env.k.app.get(PluginScopeSync).process({ kind: "org", orgId: orgA });
    await env.k.app.get(PlatformMigration).runOnce();
    expect(await comps()).toEqual([]);
    expect(await usable(orgA)).not.toContain("ext-a-notes");
    expect(
      await env.db
        .selectFrom("plugin_installs")
        .select("id")
        .where("item_id", "=", itemId)
        .execute(),
    ).toEqual([]);
    expect((await itemRow("ext-a"))?.platform_synced_version).toBeNull();
    expect(await installRow("ext-a")).toBeUndefined();
    // the owner sees it awaiting; another org sees nothing
    const a = await env.boss({ method: "GET", url: `/api/v1/orgs/${orgA}/catalog` });
    expect(
      (a.json() as { items: { id: string; state: string }[] }).items.find((i) => i.id === itemId),
    ).toMatchObject({ state: "awaiting_confirmation", awaitingConfirmation: true });
    const b = await env.root({ method: "GET", url: `/api/v1/orgs/${orgB}/catalog` });
    expect((b.json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(itemId);
    // switching it on, scope edits and the generic update are refused while it waits
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/catalog/${itemId}/switch`,
      payload: { enabled: true },
    });
    expect(errorOf(on)).toEqual([409, "catalog.item_pending"]);
    const preview = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "1.0.0" },
    });
    expect(errorOf(preview)).toEqual([409, "catalog.item_pending"]);
    const shown = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/shown`,
      payload: { shownToOthers: true },
    });
    expect(errorOf(shown)).toEqual([409, "catalog.item_pending"]);
    // the super admin's pending list and inbox show it as an org upload
    expect((await pendingItems()).find((i) => i.id === itemId)).toMatchObject({
      pending: true,
      awaitingConfirmation: true,
      pendingVersion: "1.0.0",
      owner: { kind: "org", orgId: orgA, name: "Acme" },
    });
    const inbox = await env.root({ method: "GET", url: "/api/v1/admin/inbox" });
    const items = (inbox.json() as { items: { type: string; id: string }[] }).items;
    expect(items.filter((i) => i.id === itemId).map((i) => i.type)).toEqual(["org_upload_pending"]);
    // a wrong digest is refused, nothing installed
    expect(errorOf(await superConfirm(itemId, "0".repeat(32)))).toEqual([
      409,
      "extension.approval_stale",
    ]);
    expect(await installRow("ext-a")).toBeUndefined();
  });

  it("pending items are not dependencies", async () => {
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-dep", version: "1.0.0", skills: ["ext-dep-notes"] }),
      "pending",
    );
    const r = await upload(
      env.boss,
      orgA,
      await bundlePlugin({
        name: "needs-ext",
        skills: ["needs-ext"],
        dependencies: [{ name: "ext-dep", version: "^1.0.0" }],
      }),
    );
    expect(errorOf(r)).toEqual([409, "plugin.dependency_unavailable"]);
  });

  it("super admin confirm deploys it", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-c", version: "1.0.0", skills: ["ext-c-notes"] }),
      "pending",
    );
    // the notice carries the plugin's display name, which the org inbox names it by
    await env.db
      .updateTable("catalog_items")
      .set({ display_name: JSON.stringify({ zh: "扩展 C", en: "Ext C" }) })
      .where("id", "=", itemId)
      .execute();
    const c = await superConfirm(itemId, await digestOf(itemId));
    expect(c.statusCode, c.body).toBe(200);
    expect(await installRow("ext-c")).toEqual({
      sha256: await versionSha(itemId, "1.0.0"),
      version: "1.0.0",
      desired_state: "enabled",
    });
    expect(await itemRow("ext-c")).toMatchObject({
      awaiting_confirmation: false,
      pending_version: null,
      pending_by: null,
      platform_synced_version: "1.0.0",
    });
    await waitFor(
      async () => (await usable(orgA)).includes("ext-c-notes"),
      15_000,
      "ext-c-notes usable in A",
    );
    await waitFor(async () => loaded("ext-c"), 15_000, "ext-c loaded");
    expect(await notices(orgA)).toEqual([
      {
        kind: "upload_confirmed",
        detail: {
          itemId,
          name: "ext-c",
          displayName: { zh: "扩展 C", en: "Ext C" },
          version: "1.0.0",
        },
      },
    ]);
    expect((await pendingItems()).map((i) => i.id)).not.toContain(itemId);
    // confirmed already: nothing pending
    expect(errorOf(await superConfirm(itemId, "0".repeat(32)))).toEqual([
      409,
      "extension.not_pending",
    ]);
  });

  it("every new version with an extension waits", async () => {
    const itemId = await confirmedV1("ext-v");
    await sharedWithB(itemId, "ext-v-notes");
    const v1sha = await versionSha(itemId, "1.0.0");
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-v", version: "2.0.0", skills: ["ext-v-notes"] }),
      "pending",
    );
    expect(await itemRow("ext-v")).toMatchObject({
      awaiting_confirmation: false,
      pending_version: "2.0.0",
      // a pending version is not the item's latest until confirmed (P3-34)
      latest_version: "1.0.0",
      platform_synced_version: "1.0.0",
    });
    expect((await installRow("ext-v"))?.sha256).toBe(v1sha);
    expect(imported("ext-v", "2.0.0")).toBe(false);
    // the generic update route refuses the pending version (confirm it in 待确认)
    const preview = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "2.0.0" },
    });
    expect(errorOf(preview)).toEqual([409, "catalog.item_pending"]);
    const update = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/update`,
      payload: { version: "2.0.0", diffHash: "0".repeat(32) },
    });
    expect(errorOf(update)).toEqual([409, "catalog.item_pending"]);
    expect((await installRow("ext-v"))?.sha256).toBe(v1sha);
    // the super admin confirms v2: installed, the platform moves, B is told
    const c = await superConfirm(itemId, await digestOf(itemId));
    expect(c.statusCode, c.body).toBe(200);
    expect((await installRow("ext-v"))?.sha256).toBe(await versionSha(itemId, "2.0.0"));
    expect(await itemRow("ext-v")).toMatchObject({
      pending_version: null,
      platform_synced_version: "2.0.0",
    });
    expect(await notices(orgB)).toEqual([
      {
        kind: "shared_item_updated",
        detail: expect.objectContaining({ name: "ext-v", from: "1.0.0", to: "2.0.0" }),
      },
    ]);
    expect(
      (await notices(orgA)).map((n) => [n.kind, (n.detail as { version: string }).version]),
    ).toEqual([
      ["upload_confirmed", "1.0.0"],
      ["upload_confirmed", "2.0.0"],
    ]);
    await waitFor(async () => imported("ext-v", "2.0.0"), 15_000, "ext-v 2.0.0 loaded");
  });

  it("a replaced pending version is stale", async () => {
    const itemId = await confirmedV1("ext-s");
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-s", version: "2.0.0", skills: ["ext-s-notes"] }),
      "pending",
    );
    const d2 = await digestOf(itemId);
    // a re-upload replaces the pending version (P3-11)
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-s", version: "3.0.0", skills: ["ext-s-notes"] }),
      "pending",
    );
    expect((await itemRow("ext-s"))?.pending_version).toBe("3.0.0");
    const d3 = await digestOf(itemId);
    expect(d3).not.toBe(d2);
    expect(errorOf(await superConfirm(itemId, d2))).toEqual([409, "extension.approval_stale"]);
    expect((await installRow("ext-s"))?.sha256).toBe(await versionSha(itemId, "1.0.0"));
    const c = await superConfirm(itemId, d3);
    expect(c.statusCode, c.body).toBe(200);
    expect((await installRow("ext-s"))?.sha256).toBe(await versionSha(itemId, "3.0.0"));
    expect((await itemRow("ext-s"))?.platform_synced_version).toBe("3.0.0");
  });

  it("reject and withdraw", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-r", version: "1.0.0", skills: ["ext-r-notes"] }),
      "pending",
    );
    const r = await reject(itemId, "Asks for too much");
    expect(r.statusCode, r.body).toBe(204);
    expect(await itemRow("ext-r")).toBeUndefined();
    expect(await notices(orgA)).toEqual([
      {
        kind: "upload_rejected",
        detail: {
          itemId,
          name: "ext-r",
          displayName: null,
          version: "1.0.0",
          reason: "Asks for too much",
        },
      },
    ]);
    // the name claim is released: another org (another package) can upload the name now
    expect(
      await env.db
        .selectFrom("extension_name_owners")
        .select("package_name")
        .where("name", "=", "ext-r")
        .executeTakeFirst(),
    ).toBeUndefined();
    const other = await uploaded(
      env.root,
      orgB,
      await lifePkg({ name: "ext-r", version: "1.0.0", packageName: "@b/ext-r" }),
      "pending",
    );
    expect((await itemRow("ext-r"))?.owner_org_id).toBe(orgB);
    // nothing pending -> not_pending; a platform item is the super admin's own (F11)
    expect(errorOf(await withdraw(env.boss, orgA, other))).toEqual([404, "catalog.item_not_found"]);
    const platformItem = await importPlugin(
      env,
      await lifePkg({ name: "ext-p", version: "1.0.0" }),
    );
    expect(errorOf(await reject(platformItem))).toEqual([409, "extension.not_pending"]);

    // withdraw a pending new version: cleared, v1 keeps running, no notice
    await env.db.deleteFrom("org_notices").execute();
    const wId = await confirmedV1("ext-w");
    await env.db.deleteFrom("org_notices").execute();
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-w", version: "2.0.0", skills: ["ext-w-notes"] }),
      "pending",
    );
    expect(errorOf(await withdraw(env.mem, orgA, wId))).toEqual([403, "forbidden"]);
    const w = await withdraw(env.boss, orgA, wId);
    expect(w.statusCode, w.body).toBe(204);
    expect(await itemRow("ext-w")).toMatchObject({
      pending_version: null,
      platform_synced_version: "1.0.0",
    });
    expect((await installRow("ext-w"))?.sha256).toBe(await versionSha(wId, "1.0.0"));
    expect(await notices(orgA)).toEqual([]);
    expect(errorOf(await withdraw(env.boss, orgA, wId))).toEqual([409, "extension.not_pending"]);
    expect(errorOf(await reject(wId))).toEqual([409, "extension.not_pending"]);
  });

  it("extension name race", async () => {
    const pA = await prepared(env.boss, orgA, await lifePkg({ name: "x-race", version: "1.0.0" }));
    const pB = await prepared(
      env.root,
      orgB,
      await lifePkg({ name: "x-race", version: "1.0.0", packageName: "@b/x-race" }),
    );
    const a = await confirm(env.boss, orgA, pA);
    expect(a.statusCode, a.body).toBe(201);
    const b = await confirm(env.root, orgB, pB);
    expect(errorOf(b)).toEqual([409, "extension.name_conflict"]);
    expect((b.json() as { error: { details: unknown[] } }).error.details).toEqual([
      { owner: { kind: "org", orgId: orgA, name: "Acme" } },
    ]);
    const rows = await env.db
      .selectFrom("catalog_items")
      .select(["owner_org_id"])
      .where("name", "=", "x-race")
      .execute();
    expect(rows).toEqual([{ owner_org_id: orgA }]);
  });

  it("a no-extension upload replaces an awaiting first version and applies at once", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-n", version: "1.0.0", skills: ["ext-n-notes"] }),
      "pending",
    );
    const old = await digestOf(itemId);
    const plain = await pluginTgz({
      manifest: { name: "ext-n", version: "1.1.0", skills: [{ path: "./skills/ext-n-notes" }] },
      files: { "skills/ext-n-notes/SKILL.md": SKILL_MD("ext-n-notes") },
    });
    const p = await prepared(env.boss, orgA, plain);
    expect(p.update).toBeNull();
    const c = await confirm(env.boss, orgA, p);
    expect(c.statusCode, c.body).toBe(201);
    expect((c.json() as { outcome: string }).outcome).toBe("installed");
    expect(await itemRow("ext-n")).toMatchObject({
      id: itemId,
      awaiting_confirmation: false,
      pending_version: null,
      platform_synced_version: "1.1.0",
    });
    await waitFor(
      async () => (await usable(orgA)).includes("ext-n-notes"),
      15_000,
      "ext-n-notes usable in A",
    );
    // nothing was installed under the claim: released; the old digest has nothing to confirm
    expect(
      await env.db
        .selectFrom("extension_name_owners")
        .select("package_name")
        .where("name", "=", "ext-n")
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(errorOf(await superConfirm(itemId, old))).toEqual([409, "extension.not_pending"]);
    expect(await installRow("ext-n")).toBeUndefined();
  });
});

describe("fix round 1: applied versions only, the confirm lock (P3-34 to P3-37)", {
  timeout: 180_000,
}, () => {
  const claim = (name: string) =>
    env.db
      .selectFrom("extension_name_owners")
      .select("package_name")
      .where("name", "=", name)
      .executeTakeFirst();

  it("a pending version never becomes the effective one, even before the first sync", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-ns", version: "1.0.0", skills: ["ext-ns-notes"] }),
      "pending",
    );
    // the confirm's component write fails (logged): platform_synced_version stays null
    vi.spyOn(PlatformComponents.prototype, "syncFromVersion").mockRejectedValueOnce(
      new Error("injected sync failure"),
    );
    const c = await superConfirm(itemId, await digestOf(itemId));
    expect(c.statusCode, c.body).toBe(200);
    expect((await itemRow("ext-ns"))?.platform_synced_version).toBeNull();
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-ns", version: "2.0.0", skills: ["ext-ns-notes"] }),
      "pending",
    );
    expect(await itemRow("ext-ns")).toMatchObject({
      latest_version: "1.0.0",
      pending_version: "2.0.0",
    });
    await env.k.app.get(PlatformMigration).runOnce();
    await env.k.app.get(PluginScopeSync).process({ kind: "item", itemId });
    expect((await itemRow("ext-ns"))?.platform_synced_version).toBe("1.0.0");
    const installs = await env.db
      .selectFrom("plugin_installs")
      .select("version")
      .where("item_id", "=", itemId)
      .execute();
    expect(installs.map((i) => i.version)).toEqual(["1.0.0"]);
    expect((await installRow("ext-ns"))?.sha256).toBe(await versionSha(itemId, "1.0.0"));
    expect(imported("ext-ns", "2.0.0")).toBe(false);
  });

  it("other orgs never see a pending version; a rejected one stays out of reach", async () => {
    const itemId = await confirmedV1("ext-o");
    await sharedWithB(itemId, "ext-o-notes");
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-o", version: "2.0.0", skills: ["ext-o-notes"] }),
      "pending",
    );
    const inB = await env.root({ method: "GET", url: `/api/v1/orgs/${orgB}/catalog/${itemId}` });
    expect(inB.statusCode, inB.body).toBe(200);
    expect((inB.json() as { item: unknown }).item).toMatchObject({
      latestVersion: "1.0.0",
      versions: ["1.0.0"],
    });
    expect(JSON.stringify(inB.json())).not.toContain("2.0.0");
    const inA = await env.boss({ method: "GET", url: `/api/v1/orgs/${orgA}/catalog/${itemId}` });
    expect((inA.json() as { item: unknown }).item).toMatchObject({
      latestVersion: "1.0.0",
      pendingVersion: "2.0.0",
    });
    // rejected: latest stays at 1.0.0, and the generic update cannot apply it (P3-37)
    expect((await reject(itemId, "No")).statusCode).toBe(204);
    expect(await itemRow("ext-o")).toMatchObject({
      latest_version: "1.0.0",
      pending_version: null,
    });
    const preview = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "2.0.0" },
    });
    expect(errorOf(preview)).toEqual([409, "plugin.upgrade_target_invalid"]);
    expect((await installRow("ext-o"))?.sha256).toBe(await versionSha(itemId, "1.0.0"));
  });

  it("two concurrent confirms leave the extension installed and confirmed", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-cc", version: "1.0.0", skills: ["ext-cc-notes"] }),
      "pending",
    );
    const d = await digestOf(itemId);
    const rs = await Promise.all([superConfirm(itemId, d), superConfirm(itemId, d)]);
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes, rs.map((r) => r.body).join("\n")).toEqual([200, 409]);
    expect(await installRow("ext-cc")).toMatchObject({ desired_state: "enabled" });
    expect(await itemRow("ext-cc")).toMatchObject({
      awaiting_confirmation: false,
      pending_version: null,
    });
    await waitFor(async () => loaded("ext-cc"), 15_000, "ext-cc loaded");
  });

  it("an approval that fails after the update puts the pending version back", async () => {
    const itemId = await confirmedV1("ext-ap");
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-ap", version: "2.0.0", skills: ["ext-ap-notes"] }),
      "pending",
    );
    const d = await digestOf(itemId);
    vi.spyOn(ExtensionAdmin.prototype, "approve").mockRejectedValueOnce(
      new Error("injected approval failure"),
    );
    expect((await superConfirm(itemId, d)).statusCode).toBe(500);
    expect(await itemRow("ext-ap")).toMatchObject({
      pending_version: "2.0.0",
      platform_synced_version: "2.0.0",
    });
    expect((await pendingItems()).map((i) => i.id)).toContain(itemId);
    const again = await superConfirm(itemId, d);
    expect(again.statusCode, again.body).toBe(200);
    expect((await itemRow("ext-ap"))?.pending_version).toBeNull();
    expect((await installRow("ext-ap"))?.sha256).toBe(await versionSha(itemId, "2.0.0"));
  });

  it("a leftover install of another package is refused at the confirm", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-lo", version: "1.0.0" }),
      "pending",
    );
    // another package's install of the name appears after the upload (legacy data)
    const other = await env.k.app
      .get(ExtensionInstalls)
      .ingest(
        null,
        await lifePkg({ name: "ext-lo", version: "1.0.0", packageName: "@other/ext-lo" }),
        { source: "file", ref: "upload" },
      );
    await env.db
      .insertInto("extension_installs")
      .values({
        name: "ext-lo",
        sha256: other.sha256,
        version: "1.0.0",
        source: "file",
        desired_state: "disabled",
        installed_by: null,
        updated_by: null,
      })
      .execute();
    const c = await superConfirm(itemId, await digestOf(itemId));
    expect(errorOf(c)).toEqual([409, "extension.name_conflict"]);
    expect((await installRow("ext-lo"))?.sha256).toBe(other.sha256);
    expect((await itemRow("ext-lo"))?.awaiting_confirmation).toBe(true);
    await env.db.deleteFrom("extension_installs").where("name", "=", "ext-lo").execute();
  });

  it("a super admin delete of an awaiting item releases its name claim", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-del", version: "1.0.0" }),
      "pending",
    );
    expect(await claim("ext-del")).toBeDefined();
    const r = await env.root({ method: "DELETE", url: `/api/v1/admin/catalog/items/${itemId}` });
    expect(r.statusCode, r.body).toBe(204);
    expect(await claim("ext-del")).toBeUndefined();
  });
});

describe("fix round 2: the scope sync waits for its replica to load the extension (P3-38)", {
  timeout: 180_000,
}, () => {
  it("a replica that has not loaded the confirmed extension yet retries, then converges", async () => {
    const registry = env.k.app.get(ExtensionRegistry);
    const real = registry.manifests.bind(registry);
    // this replica's host has not loaded ext-late yet (another replica confirmed it)
    let hidden = true;
    vi.spyOn(registry, "manifests").mockImplementation(() =>
      real().filter((m) => !hidden || m.name !== "ext-late"),
    );
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-late", version: "1.0.0", skills: ["ext-late-notes"] }),
      "pending",
    );
    const c = await superConfirm(itemId, await digestOf(itemId));
    expect(c.statusCode, c.body).toBe(200);
    // the sync defers (no install, no failure) and owes a delayed retry of the item (an outbox
    // row due in a few seconds, then the queued job)
    const row = await itemRow("ext-late");
    const retryId = scopeRetryJobId(itemId, row?.scope_version ?? 0, 1);
    await waitFor(
      async () =>
        (await env.db
          .selectFrom("outbox")
          .select("id")
          .where("queue", "=", PLUGIN_SCOPE_QUEUE)
          .where("job_id", "=", retryId)
          .executeTakeFirst()) !== undefined ||
        (await env.k.app.get<Queue>(getQueueToken(PLUGIN_SCOPE_QUEUE)).getJob(retryId)) !==
          undefined,
      15_000,
      "retry job owed",
    );
    expect(
      await env.db
        .selectFrom("plugin_scope_sync_failures")
        .select("code")
        .where("item_id", "=", itemId)
        .execute(),
    ).toEqual([]);
    expect(await usable(orgA)).not.toContain("ext-late-notes");
    // the replica loads it: the retry installs it
    hidden = false;
    await waitFor(
      async () => (await usable(orgA)).includes("ext-late-notes"),
      30_000,
      "ext-late-notes usable in A after the retry",
    );
  });

  it("once the retries are used up the failure is recorded as before", async () => {
    const itemId = await confirmedV1("ext-gone");
    // uninstalled in org A by the test, then the replica never loads the extension again
    await env.db.deleteFrom("plugin_install_components").execute();
    await env.db.deleteFrom("plugin_installs").where("item_id", "=", itemId).execute();
    const registry = env.k.app.get(ExtensionRegistry);
    const real = registry.manifests.bind(registry);
    vi.spyOn(registry, "manifests").mockImplementation(() =>
      real().filter((m) => m.name !== "ext-gone"),
    );
    await env.k.app
      .get(PluginScopeSync)
      .process({ kind: "item", itemId, retry: SCOPE_LOAD_RETRIES });
    const failures = await env.db
      .selectFrom("plugin_scope_sync_failures")
      .select(["org_id", "code"])
      .where("item_id", "=", itemId)
      .execute();
    expect(failures).toEqual([{ org_id: orgA, code: "catalog.not_deployed" }]);
  });
});

describe("final review fixes: package identity and version applicability (P3-51, P3-52)", {
  timeout: 180_000,
}, () => {
  const nameOwner = (r: { body: string }) =>
    (JSON.parse(r.body) as { error: { details?: unknown[] } }).error.details;

  /** Removes A's item the way a pending cleanup leaves it: deleted, its extension installed. */
  const removedUncleaned = (itemId: string) =>
    env.db
      .updateTable("catalog_items")
      .set({ deleted_at: sql<Date>`now()` as unknown as Date })
      .where("id", "=", itemId)
      .execute();

  const claimOf = (name: string) =>
    env.db
      .selectFrom("extension_name_owners")
      .select("package_name")
      .where("name", "=", name)
      .executeTakeFirst();

  it("another org's no-extension upload with a removed item's package is refused and never blocks its cleanup", async () => {
    const itemA = await confirmedV1("pk-a");
    await removedUncleaned(itemA);
    // org B reuses A's npm package name for a plugin of its own (no extension)
    const b = await upload(
      env.root,
      orgB,
      await bundlePlugin({
        name: "pk-b",
        skills: ["pk-b-notes"],
        packageName: "@test/plugin-pk-a",
      }),
    );
    expect(errorOf(b)).toEqual([409, "plugin.name_taken"]);
    expect(nameOwner(b)).toEqual([{ owner: { kind: "org", orgId: orgA, name: "Acme" } }]);
    // even if such an item exists (written before the refusal existed), the cleanup compares
    // the item and its owner, never the package name alone
    await env.db
      .insertInto("catalog_items")
      .values({
        id: randomUUID(),
        name: "pk-b",
        package_name: "@test/plugin-pk-a",
        publisher: "B",
        description: "pk-b",
        latest_version: "1.0.0",
        created_by: env.rootId,
        owner_org_id: orgB,
      })
      .execute();
    expect(await installRow("pk-a")).toBeDefined();
    await env.k.app.get(OwnedPluginCleanup).run(itemA);
    expect(await installRow("pk-a")).toBeUndefined();
    expect(await claimOf("pk-a")).toBeUndefined();
  });

  it("another org's extension upload of a removed item's name and package never takes its install over", async () => {
    const itemA = await confirmedV1("pk-x");
    const shaA = (await installRow("pk-x"))?.sha256;
    await removedUncleaned(itemA);
    const bytes = await lifePkg({ name: "pk-x", version: "2.0.0" });
    const b = await upload(env.root, orgB, bytes);
    expect(errorOf(b)).toEqual([409, "plugin.name_taken"]);
    expect(nameOwner(b)).toEqual([{ owner: { kind: "org", orgId: orgA, name: "Acme" } }]);
    // A's install cleaned up: B may now upload the name, pending as any first version
    await env.k.app.get(OwnedPluginCleanup).run(itemA);
    expect(await installRow("pk-x")).toBeUndefined();
    const itemB = await uploaded(env.root, orgB, bytes, "pending");
    // A's install shows up again under its own item (a cleanup racing, legacy data); its
    // package is kept while A's version row refers to it
    await env.db
      .insertInto("extension_installs")
      .values({
        name: "pk-x",
        sha256: shaA as string,
        version: "1.0.0",
        source: "catalog",
        desired_state: "disabled",
        installed_by: null,
        updated_by: null,
        catalog_item_id: itemA,
      })
      .execute();
    // the super admin's confirm of B refuses: B never inherits A's install, config or data
    const c = await superConfirm(itemB, await digestOf(itemB));
    expect(errorOf(c)).toEqual([409, "extension.name_conflict"]);
    expect(nameOwner(c)).toEqual([{ owner: { kind: "org", orgId: orgA, name: "Acme" } }]);
    expect(await installRow("pk-x")).toMatchObject({ sha256: shaA, version: "1.0.0" });
    expect((await itemRow("pk-x"))?.awaiting_confirmation).toBe(true);
    await env.db.deleteFrom("extension_installs").where("name", "=", "pk-x").execute();
  });

  it("a reject releases the name claim under the per-name install lock", async () => {
    const itemId = await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "ext-rl", version: "1.0.0" }),
      "pending",
    );
    const locked = vi.spyOn(PluginInstallLock.prototype, "lock");
    expect((await reject(itemId)).statusCode).toBe(204);
    expect(locked.mock.calls).toContainEqual(["ext-rl"]);
    expect(await claimOf("ext-rl")).toBeUndefined();
  });

  it("a transferred plugin keeps its rejected and never-applied versions out of reach", async () => {
    const itemId = await confirmedV1("tr-v");
    await sharedWithB(itemId, "tr-v-notes");
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "tr-v", version: "2.0.0", skills: ["tr-v-notes"] }),
      "pending",
    );
    expect((await reject(itemId, "No")).statusCode).toBe(204);
    await uploaded(
      env.boss,
      orgA,
      await lifePkg({ name: "tr-v", version: "3.0.0", skills: ["tr-v-notes"] }),
      "pending",
    );
    // org A deletes it while B uses it: transferred to the platform
    const owned = `/api/v1/orgs/${orgA}/owned-plugins/${itemId}`;
    const p = await env.boss({ method: "POST", url: `${owned}/delete/preview` });
    expect(p.statusCode, p.body).toBe(200);
    expect((p.json() as { outcome: string }).outcome).toBe("transferred");
    const d = await env.boss({
      method: "POST",
      url: `${owned}/delete`,
      payload: { previewHash: (p.json() as { previewHash: string }).previewHash },
    });
    expect(d.statusCode, d.body).toBe(204);
    expect((await itemRow("tr-v"))?.owner_org_id).toBeNull();
    // the generic update reaches neither the rejected nor the never-applied version
    for (const version of ["2.0.0", "3.0.0"]) {
      const preview = await env.root({
        method: "POST",
        url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
        payload: { version },
      });
      expect(errorOf(preview)).toEqual([409, "plugin.upgrade_target_invalid"]);
    }
    // other orgs (B) see only the applied version
    const inB = await env.root({ method: "GET", url: `/api/v1/orgs/${orgB}/catalog/${itemId}` });
    expect(inB.statusCode, inB.body).toBe(200);
    expect((inB.json() as { item: unknown }).item).toMatchObject({
      latestVersion: "1.0.0",
      versions: ["1.0.0"],
    });
    const rows = await env.db
      .selectFrom("catalog_item_versions")
      .select(["version", "applied_at", "rejected_at"])
      .where("item_id", "=", itemId)
      .orderBy("version")
      .execute();
    expect(rows.map((r) => [r.version, r.applied_at !== null, r.rejected_at !== null])).toEqual([
      ["1.0.0", true, false],
      ["2.0.0", false, true],
      ["3.0.0", false, false],
    ]);
    expect((await installRow("tr-v"))?.sha256).toBe(await versionSha(itemId, "1.0.0"));
  });
});
