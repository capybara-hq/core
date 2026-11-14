import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogScopeService } from "../../src/catalog/catalog-scope.service.js";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import {
  PLUGIN_SCOPE_QUEUE,
  PluginScopeSync,
  SCOPE_BACKSTOP_JOB,
  SCOPE_ITEM_JOB,
  SCOPE_ORG_JOB,
  scopeBackstopJobId,
  scopeItemJobId,
  scopeOrgJobId,
} from "../../src/catalog/scope-sync.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { outboxJobOptions } from "../../src/infra/outbox/registry.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { drainOutbox } from "../helpers/outbox.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, type Req, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  importPlugin,
  install,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setScope,
  startOrgEnv,
  TEST_SCOPE_BACKSTOP_DELAY_MS,
} from "./org-env.js";
import { bundlePlugin, mcpTemplate, skillFiles, skillPlugin } from "./packages.js";
import { syncPlatformComponents } from "./platform-sync.js";

/**
 * The platform components of a plugin, their import update, and the scope syncs they owe:
 *
 * - plugin scope phase 2, Task 2: the platform components of a plugin version. The confirm that
 *   creates a catalog item writes one platform row per skill, agent template and connector
 *   template (files under `deployment/platform/…`); a new version of the item leaves them alone
 *   (updates go through the platform plugin update); a sync adds a version only when content
 *   changed;
 * - the platform's update of an installed plugin to a version staged for import (the one 更新到
 *   wizard, maintainer decision 2026-11-13, `PlatformImportUpdate`): the import review and the
 *   update preview of the staged version are confirmed together; nothing is written before that
 *   confirm, and an update failing after the import leaves the platform where it was with the
 *   version imported, saying so;
 * - transactional outbox spec §8.1 (catalog rows): a scope change, a new org and an ownership
 *   transfer owe the plugin scope sync in their own transaction; a confirmation's commit owes a
 *   delayed backstop (ruling R24). The fast path is disabled for the scope queue
 *   (`OUTBOX_DISPATCH_FAILS`, while `failing` is set), so what converges the orgs got there
 *   through an owed row an explicit relay pass delivered.
 */

let env: OrgEnv;
/** A second org (root owns it). */
let orgB: string;
/** While true, the outbox's adds to the plugin scope queue fail. */
let failing = false;

beforeAll(async () => {
  env = await startOrgEnv({
    kernelOverrides: [
      {
        provide: OUTBOX_DISPATCH_FAILS,
        useValue: (queue: string) => failing && queue === PLUGIN_SCOPE_QUEUE,
      },
    ],
  });
  orgB = await createOrg(env.root, "Owed B");
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  failing = false;
  // also drops the scope queue's owed rows a previous test left
  await resetOrgCatalog(env);
});

const reviewerMd = (body = "Review the change.") =>
  `---\nname: reviewer\ndescription: Reviews kit work.\n---\n${body}\n`;

/** Plugin `kit`: skills alpha and beta, agent template reviewer, connector template kit-mcp. */
const kit = (version: string, o: { alphaMd?: string; reviewer?: string } = {}) =>
  bundlePlugin({
    name: "kit",
    version,
    skills: ["beta"],
    templates: { "kit-mcp": mcpTemplate() },
    files: {
      ...skillFiles("alpha", o.alphaMd ?? SKILL_MD("alpha", "Alpha things.")),
      "agents/reviewer.md": o.reviewer ?? reviewerMd(),
    },
  });

const readText = async (key: string): Promise<string | null> => {
  const got = await env.k.app.get(StorageService).deployment().get(key);
  return got ? await new Response(got.body).text() : null;
};

const skillRows = () =>
  env.db
    .selectFrom("platform_skills as s")
    .innerJoin("platform_skill_versions as v", (j) =>
      j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
    )
    .select([
      "s.id",
      "s.catalog_item_id",
      "s.plugin_name",
      "s.name",
      "s.description",
      "s.current_version",
      "s.scope_mode",
      "v.object_prefix",
      "v.catalog_version",
      "v.manifest",
    ])
    .orderBy("s.name")
    .execute();

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

/** The scope queue's owed (not dead) outbox rows. */
const owed = () =>
  env.db
    .selectFrom("outbox")
    .select(["job_name", "job_id", "data", "org_id"])
    .where("queue", "=", PLUGIN_SCOPE_QUEUE)
    .where("dead_at", "is", null)
    .orderBy("id")
    .execute();

/**
 * Lets the scope queue's adds succeed, runs one relay pass over the owed rows, each due now (a
 * backstop's `runAt` brought forward), and waits until every row is delivered (a concurrent pass
 * may hold some: {@link drainOutbox}).
 */
async function relay(): Promise<void> {
  failing = false;
  await env.db
    .updateTable("outbox")
    .set({ next_attempt_at: sql<Date>`now()` as unknown as Date, run_at: null })
    .where("queue", "=", PLUGIN_SCOPE_QUEUE)
    .execute();
  await drainOutbox(env.k.app, { queue: PLUGIN_SCOPE_QUEUE });
}

/** The live installs of an item, as the orgs they are in. */
async function liveOrgs(itemId: string): Promise<string[]> {
  const rows = await env.db
    .selectFrom("plugin_installs")
    .select("org_id")
    .where("item_id", "=", itemId)
    .where("status", "in", ["installing", "installed", "upgrading"])
    .execute();
  return rows.map((r) => r.org_id).sort();
}

async function liveOrgIds(): Promise<string[]> {
  const rows = await env.db
    .selectFrom("orgs")
    .select("id")
    .where("deleted_at", "is", null)
    .execute();
  return rows.map((r) => r.id).sort();
}

const scopeVersion = async (itemId: string) =>
  (
    await env.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow()
  ).scope_version;

/** Uploads and confirms a skills-only package in the org (installed at once); returns its id. */
async function uploaded(req: Req, orgId: string, bytes: Uint8Array): Promise<string> {
  const base = `/api/v1/orgs/${orgId}/catalog/uploads`;
  const p = await req({
    method: "POST",
    url: `${base}/file`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(p.statusCode, p.body).toBe(200);
  const prepared = p.json() as { stagingId: string; review: { reviewHash: string } };
  const c = await req({
    method: "POST",
    url: `${base}/${prepared.stagingId}/confirm`,
    payload: { reviewHash: prepared.review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  expect((c.json() as { outcome: string }).outcome).toBe("installed");
  return (c.json() as { item: { id: string } }).item.id;
}

describe("platform components from a plugin version", () => {
  it("the confirm that creates the item writes skills, agent templates and connector templates", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));

    const skills = await skillRows();
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    for (const s of skills) {
      expect(s).toMatchObject({
        catalog_item_id: itemId,
        plugin_name: "kit",
        current_version: 1,
        scope_mode: "follow",
        catalog_version: "1.0.0",
        // keyed by content: a retried import copies nothing again
        object_prefix: expect.stringMatching(/^platform\/skills\/sha256-[0-9a-f]{64}\/$/),
      });
      expect(await readText(`${s.object_prefix}SKILL.md`)).toContain(`name: ${s.name}`);
      expect(await readText(`${s.object_prefix}scripts/run.py`)).toBe("print(1)\n");
    }
    expect(skills[0]?.description).toBe("Alpha things.");
    expect(
      (skills[0]?.manifest as { files: { path: string }[] } | undefined)?.files
        .map((f) => f.path)
        .sort(),
    ).toEqual(["SKILL.md", "scripts/run.py"]);

    const templates = await env.db
      .selectFrom("platform_agent_templates as t")
      .innerJoin("platform_agent_template_versions as v", (j) =>
        j.onRef("v.template_id", "=", "t.id").onRef("v.version", "=", "t.current_version"),
      )
      .select([
        "t.id",
        "t.catalog_item_id",
        "t.plugin_name",
        "t.name",
        "t.description",
        "t.current_version",
        "t.scope_mode",
        "v.definition",
        "v.object_prefix",
        "v.catalog_version",
      ])
      .execute();
    expect(templates).toHaveLength(1);
    const tpl = templates[0];
    expect(tpl).toMatchObject({
      catalog_item_id: itemId,
      plugin_name: "kit",
      name: "reviewer",
      description: "Reviews kit work.",
      current_version: 1,
      scope_mode: "follow",
      catalog_version: "1.0.0",
      object_prefix: expect.stringMatching(/^platform\/agent-templates\/sha256-[0-9a-f]{64}\/$/),
      definition: expect.objectContaining({
        name: "reviewer",
        instructions: "Review the change.\n",
      }),
    });
    expect(await readText(`${tpl?.object_prefix}reviewer.md`)).toBe(reviewerMd());

    const connectors = await env.db
      .selectFrom("platform_connector_templates")
      .selectAll()
      .execute();
    expect(connectors).toHaveLength(1);
    expect(connectors[0]).toMatchObject({
      catalog_item_id: itemId,
      template_id: "kit-mcp",
      current_version: "1.0.0",
      scope_mode: "follow",
      file: expect.objectContaining({ template: expect.objectContaining({ connector: "fake" }) }),
    });
  });

  it("a new version of the item leaves the platform rows alone", async () => {
    await importPlugin(env, await kit("1.0.0"));
    const before = await skillRows();
    await importPlugin(
      env,
      await kit("1.1.0", {
        alphaMd: SKILL_MD("alpha", "Alpha, changed."),
        reviewer: reviewerMd("Review harder."),
      }),
    );
    expect(await skillRows()).toEqual(before);
    const t = await env.db
      .selectFrom("platform_agent_templates")
      .select("current_version")
      .executeTakeFirstOrThrow();
    expect(t.current_version).toBe(1);
  });

  it("a sync adds a version only for changed content", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    const first = (await skillRows()).find((s) => s.name === "alpha");
    await importPlugin(
      env,
      await kit("1.1.0", {
        alphaMd: SKILL_MD("alpha", "Alpha, changed."),
        reviewer: reviewerMd("Review harder."),
      }),
    );
    const r = await syncPlatformComponents(env.k.app, itemId, "1.1.0");
    const alpha = (await skillRows()).find((s) => s.name === "alpha");
    expect(r.skills).toEqual([{ kind: "skill", id: alpha?.id, name: "alpha", from: 1, to: 2 }]);
    expect(r.agentTemplates).toEqual([
      expect.objectContaining({ kind: "agent_template", name: "reviewer", from: 1, to: 2 }),
    ]);
    expect(r.connectorTemplates).toEqual([]);
    expect(alpha).toMatchObject({
      current_version: 2,
      description: "Alpha, changed.",
      catalog_version: "1.1.0",
      object_prefix: expect.stringMatching(/^platform\/skills\/sha256-[0-9a-f]{64}\/$/),
    });
    expect(alpha?.object_prefix).not.toBe(first?.object_prefix);
    expect(await readText(`${alpha?.object_prefix}SKILL.md`)).toContain("Alpha, changed.");
    // the first version's files stay
    expect(await readText(`${first?.object_prefix}SKILL.md`)).toContain("Alpha things.");
    const beta = (await skillRows()).find((s) => s.name === "beta");
    expect(beta?.current_version).toBe(1);

    // the same version again changes nothing
    expect(await syncPlatformComponents(env.k.app, itemId, "1.1.0")).toEqual({
      skills: [],
      agentTemplates: [],
      connectorTemplates: [],
      themes: [],
    });
  });

  it("a plugin without components (an extension only) creates nothing", async () => {
    await importPlugin(env, await bundlePlugin({ name: "empty", version: "1.0.0", extension: {} }));
    expect(await env.db.selectFrom("platform_skills").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("platform_agent_templates").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("platform_connector_templates").select("id").execute()).toEqual(
      [],
    );
  });
});

describe("platform import and update (one wizard)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

describe("plugin scope syncs are owed (transactional outbox §8.1)", () => {
  it("changing an item's scope converges every org with the fast path disabled", async () => {
    const itemId = await seedPlugin(env, {
      name: "owed-scope",
      skills: ["owed-scope-skill"],
      templates: false,
    });
    failing = true;
    const base = `/api/v1/admin/catalog/items/${itemId}/scope`;
    const p = await env.root({ method: "POST", url: `${base}/preview`, payload: { scope: "all" } });
    expect(p.statusCode, p.body).toBe(200);
    const r = await env.root({
      method: "PUT",
      url: base,
      payload: { scope: "all", scopeHash: (p.json() as { scopeHash: string }).scopeHash },
    });
    expect(r.statusCode, r.body).toBe(200);
    // committed with the scope: one owed item job for the new scope version, nothing installed
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_ITEM_JOB,
        job_id: scopeItemJobId(itemId, await scopeVersion(itemId)),
        data: { kind: "item", itemId },
        org_id: null,
      },
    ]);
    expect(await liveOrgs(itemId)).toEqual([]);
    await relay();
    const all = await liveOrgIds();
    expect(all).toContain(orgB);
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === all.join(),
      30_000,
      "installed in every org",
    );
    expect(await owed()).toEqual([]);
  });

  it("a new org gets the all-scope items with the fast path disabled", async () => {
    const itemId = await seedPlugin(env, {
      name: "owed-new-org",
      skills: ["owed-new-org-skill"],
      templates: false,
    });
    // written directly: no sync for the orgs that exist
    await setScope(env, itemId, "all");
    failing = true;
    const orgC = await createOrg(env.root, `Owed C ${Date.now()}`);
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_ORG_JOB,
        job_id: scopeOrgJobId(orgC),
        data: { kind: "org", orgId: orgC },
        org_id: orgC,
      },
    ]);
    expect(await liveOrgs(itemId)).toEqual([]);
    await relay();
    await waitFor(
      async () => (await liveOrgs(itemId)).includes(orgC),
      30_000,
      "installed in the new org",
    );
    expect(await owed()).toEqual([]);
  });

  it("transferring an owned item with the fast path disabled cleans the old install up", async () => {
    const orgA = env.orgId;
    const itemId = await uploaded(env.boss, orgA, await skillPlugin("owed-tx"));
    await waitFor(
      async () => (await liveOrgs(itemId)).includes(orgA),
      30_000,
      "installed in the owner org",
    );
    // shared with B, where the scope sync installs it
    const s = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/owned-plugins/${itemId}/shareable`,
      payload: { shareable: true },
    });
    expect(s.statusCode, s.body).toBe(204);
    await setScope(env, itemId, "named", [orgA, orgB]);
    await env.k.app
      .get(TransactionHost)
      .run(() => env.k.app.get(CatalogScopeService).enqueueSync(itemId));
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === [orgA, orgB].sort().join(),
      30_000,
      "installed in B",
    );
    // the syncs owed so far are delivered (their passes committed) before adds start failing
    await drainOutbox(env.k.app, { queue: PLUGIN_SCOPE_QUEUE, jobName: SCOPE_ITEM_JOB });
    // the owner deletes it: B uses it, so it is transferred and A leaves its list
    failing = true;
    const owned = `/api/v1/orgs/${orgA}/owned-plugins/${itemId}/delete`;
    const p = await env.boss({ method: "POST", url: `${owned}/preview` });
    expect(p.statusCode, p.body).toBe(200);
    expect((p.json() as { outcome: string }).outcome).toBe("transferred");
    const d = await env.boss({
      method: "POST",
      url: owned,
      payload: { previewHash: (p.json() as { previewHash: string }).previewHash },
    });
    expect(d.statusCode, d.body).toBe(204);
    // (the upload's backstop may still be owed too: only the transfer's job is checked)
    expect((await owed()).filter((r) => r.job_name === SCOPE_ITEM_JOB)).toEqual([
      {
        job_name: SCOPE_ITEM_JOB,
        job_id: scopeItemJobId(itemId, await scopeVersion(itemId)),
        data: { kind: "item", itemId },
        org_id: null,
      },
    ]);
    // the former owner's install is still there until the owed sync runs
    expect(await liveOrgs(itemId)).toContain(orgA);
    await relay();
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === orgB,
      30_000,
      "the former owner's install removed",
    );
    expect(await owed()).toEqual([]);
  });

  it("a crash between an import's commit and its post-deploy add: the backstop converges the orgs", async () => {
    // the confirm's process dies after the deploy, before it owes the immediate sync
    const svc = env.k.app.get(CatalogScopeService) as unknown as {
      oweSync: (itemId: string) => Promise<void>;
    };
    const oweSync = svc.oweSync;
    svc.oweSync = async () => {};
    failing = true;
    let itemId: string;
    try {
      const p = await env.root({
        method: "POST",
        url: "/api/v1/admin/catalog/import/file",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from(await skillPlugin("owed-backstop")),
      });
      expect(p.statusCode, p.body).toBe(200);
      const c = await env.root({
        method: "POST",
        url: `/api/v1/admin/catalog/imports/${p.json().stagingId}/confirm`,
        payload: { reviewHash: p.json().review.reviewHash, scope: "all" },
      });
      expect(c.statusCode, c.body).toBe(201);
      itemId = (c.json() as { item: { id: string } }).item.id;
    } finally {
      svc.oweSync = oweSync;
    }
    // only the backstop the commit owed, due five minutes on; nothing installed
    expect(await owed()).toEqual([
      {
        job_name: SCOPE_BACKSTOP_JOB,
        job_id: scopeBackstopJobId(itemId, await scopeVersion(itemId)),
        data: { kind: "item", itemId, backstop: true },
        org_id: null,
      },
    ]);
    const row = await env.db
      .selectFrom("outbox")
      .select(["run_at", "created_at"])
      .where("queue", "=", PLUGIN_SCOPE_QUEUE)
      .executeTakeFirstOrThrow();
    expect(
      new Date(row.run_at as Date).getTime() - new Date(row.created_at).getTime(),
    ).toBeGreaterThan(TEST_SCOPE_BACKSTOP_DELAY_MS - 60_000);
    expect(await liveOrgs(itemId)).toEqual([]);
    // its time comes: the orgs converge
    await relay();
    const all = await liveOrgIds();
    await waitFor(
      async () => (await liveOrgs(itemId)).join() === all.join(),
      30_000,
      "installed in every org by the backstop",
    );
    expect(await owed()).toEqual([]);
  });

  it("a backstop whose extension is not deployed throws for a BullMQ retry and records no failure", async () => {
    // retried with backoff, bounded by its attempts
    expect(outboxJobOptions(SCOPE_BACKSTOP_JOB)).toMatchObject({ attempts: 5 });
    const itemId = await seedPlugin(env, {
      name: "owed-ghost",
      extension: true,
      skills: [],
      templates: false,
    });
    await setScope(env, itemId, "all");
    const sync = env.k.app.get(PluginScopeSync);
    await expect(sync.process({ kind: "item", itemId, backstop: true })).rejects.toThrow(
      /not enabled on the deployment yet/,
    );
    expect(await liveOrgs(itemId)).toEqual([]);
    expect(
      await env.db
        .selectFrom("plugin_scope_sync_failures")
        .select("code")
        .where("item_id", "=", itemId)
        .execute(),
    ).toEqual([]);
    // an extension loaded here (config-declared: no install record) passes the check
    const loaded = await seedPlugin(env, {
      name: "fake-tools-ui",
      extension: true,
      skills: [],
      templates: false,
    });
    await expect(
      sync.process({ kind: "item", itemId: loaded, backstop: true }),
    ).resolves.toBeUndefined();
  });
});
