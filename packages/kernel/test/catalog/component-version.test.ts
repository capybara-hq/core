import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usableTemplates } from "../../src/agents/templates.js";
import { PlatformComponents, type PreparedSync } from "../../src/catalog/platform-components.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import { usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { makeZip, SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  importPlugin,
  install,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  startOrgEnv,
} from "./org-env.js";
import { bundlePlugin, mcpTemplate, skillFiles } from "./packages.js";

/**
 * The platform components of a plugin version and their own life:
 *
 * - platform skills carry a catalog version's source format and the per-skill pinned suggestion
 *   (phase B, spec §9.1), also through a platform plugin update, and the skills API shows them;
 * - a platform skill or agent template updated on its own (plugin scope phase 2, Task 8, spec §7.2):
 *   the upload keeps the plugin provenance, writes the next version flagged `updated_on_own`,
 *   serves in orgs at once, and the next plugin update preview marks it;
 * - a plugin import writes its platform component rows in the import's transaction (transactional
 *   outbox Task 15, spec §8.1, design review `catalog-import-heal-job`): the files are copied
 *   before it, keyed by content, so a failed import leaves no item, no rows and nothing a retry
 *   would copy again; no job heals an item afterwards.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

/** Installs the plugin in the org. */
async function installOk(itemId: string): Promise<string> {
  const r = await install(env.boss, env, itemId, {});
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

/** The platform skill versions. */
const versionsOf = () =>
  env.db
    .selectFrom("platform_skill_versions as v")
    .innerJoin("platform_skills as s", "s.id", "v.skill_id")
    .select(["s.name", "v.version", "v.source_format", "v.suggest_pinned"])
    .orderBy("s.name")
    .orderBy("v.version")
    .execute();

/** Previews and confirms the platform update to `version`; returns the skill changes. */
async function updateTo(itemId: string, version: string): Promise<string[]> {
  const p = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
    payload: { version },
  });
  expect(p.statusCode, p.body).toBe(200);
  const r = await env.root({
    method: "PUT",
    url: `/api/v1/admin/catalog/items/${itemId}/update`,
    payload: { version, diffHash: p.json().diffHash },
  });
  expect(r.statusCode, r.body).toBe(200);
  return (p.json().components as { kind: string; change: string }[])
    .filter((c) => c.kind === "skill")
    .map((c) => c.change);
}

const seedSuperpowers = (o: { version?: string; addTo?: string; legacyPinned?: string[] } = {}) =>
  seedPlugin(env, {
    name: "superpowers",
    skills: ["brainstorming", "using-superpowers"],
    templates: false,
    legacyPinned: o.legacyPinned ?? ["using-superpowers"],
    sourceFormat: "claude-code",
    ...(o.version !== undefined && { version: o.version }),
    ...(o.addTo !== undefined && { addTo: o.addTo }),
    // a 2.0.0 changes both skills' files, so the upgrade writes a new version of each
    ...(o.version === "2.0.0" && {
      skillScripts: { brainstorming: "print(2)\n", "using-superpowers": "print(2)\n" },
    }),
  });

const reviewerMd = (body: string) =>
  `---\nname: reviewer\ndescription: Reviews kit work.\n---\n${body}\n`;

async function importKit(): Promise<string> {
  return importPlugin(
    env,
    await bundlePlugin({
      name: "kit",
      version: "1.0.0",
      skills: [],
      files: {
        ...skillFiles("alpha", SKILL_MD("alpha", "Alpha things.")),
        "agents/reviewer.md": reviewerMd("Review the change."),
      },
    }),
  );
}

const skillOf = (name: string) =>
  env.db
    .selectFrom("platform_skills")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
const templateOf = (name: string) =>
  env.db
    .selectFrom("platform_agent_templates")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirstOrThrow();

/** Make the component on in every org (own scope, all). */
async function onEverywhere(table: "platform_skills" | "platform_agent_templates", id: string) {
  await env.db
    .updateTable(table)
    .set({ scope_mode: "own", scope: "all" })
    .where("id", "=", id)
    .execute();
}

const uploadSkill = (id: string, body: Buffer | string, req = env.root) =>
  req({
    method: "POST",
    url: `/api/v1/admin/components/skill/${id}/versions`,
    headers: { "content-type": "application/octet-stream" },
    payload: body,
  });

const uploadTemplate = (id: string, content: string, req = env.root) =>
  req({
    method: "POST",
    url: `/api/v1/admin/components/agent_template/${id}/versions`,
    payload: { content },
  });

const readText = async (key: string): Promise<string | null> => {
  const got = await env.k.app.get(StorageService).deployment().get(key);
  return got ? await new Response(got.body).text() : null;
};

/** Imports kit 2.0.0 (a new version of the item; platform rows are left alone) and previews it. */
async function previewV2(
  itemId: string,
  reviewer = "Review the change.",
): Promise<PlatformUpdatePreview> {
  await importPlugin(
    env,
    await bundlePlugin({
      name: "kit",
      version: "2.0.0",
      skills: [],
      files: {
        ...skillFiles("alpha", SKILL_MD("alpha", "Alpha 2.")),
        "agents/reviewer.md": reviewerMd(reviewer),
      },
    }),
  );
  const r = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
    payload: { version: "2.0.0" },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as PlatformUpdatePreview;
}

/** Plugin `kit`: skills alpha and beta, agent template reviewer, connector template kit-mcp. */
const kit = () =>
  bundlePlugin({
    name: "kit",
    version: "1.0.0",
    skills: ["beta"],
    templates: { "kit-mcp": mcpTemplate() },
    files: {
      ...skillFiles("alpha", SKILL_MD("alpha", "Alpha things.")),
      "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews kit work.\n---\nReview.\n",
    },
  });

async function prepare(): Promise<{ stagingId: string; reviewHash: string }> {
  const r = await env.root({
    method: "POST",
    url: "/api/v1/admin/catalog/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(await kit()),
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { stagingId: string; review: { reviewHash: string } };
  return { stagingId: body.stagingId, reviewHash: body.review.reviewHash };
}

const confirm = (p: { stagingId: string; reviewHash: string }) =>
  env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${p.stagingId}/confirm`,
    payload: { reviewHash: p.reviewHash },
  });

/** Every object under the platform components' prefix. */
async function platformObjects(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.k.app
      .get(StorageService)
      .deployment()
      .list("platform/", cursor === undefined ? {} : { cursor });
    keys.push(...page.items.map((o) => o.key));
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  return keys.sort();
}

/** The object prefixes the platform version rows reference. */
async function referencedPrefixes(): Promise<string[]> {
  const skills = await env.db
    .selectFrom("platform_skill_versions")
    .select("object_prefix")
    .execute();
  const agents = await env.db
    .selectFrom("platform_agent_template_versions")
    .select("object_prefix")
    .execute();
  return [...skills, ...agents]
    .flatMap((r) => (r.object_prefix === null ? [] : [r.object_prefix]))
    .sort();
}

/** The platform rows of the import fail after they are written, in its transaction. */
function failPlatformWrite(): void {
  const original = PlatformComponents.prototype.applySyncIn;
  vi.spyOn(PlatformComponents.prototype, "applySyncIn").mockImplementationOnce(async function (
    this: PlatformComponents,
    p: PreparedSync,
  ) {
    await original.call(this, p);
    throw new Error("injected platform write failure");
  });
}

const kitItem = () =>
  env.db
    .selectFrom("catalog_items")
    .select(["id", "platform_synced_version"])
    .where("name", "=", "kit")
    .where("deleted_at", "is", null)
    .executeTakeFirst();

describe("org skills from a Claude Code plugin", () => {
  it("the org catalog view carries the latest version's source format", async () => {
    const item = await seedSuperpowers();
    const r = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    expect(r.statusCode, r.body).toBe(200);
    const view = (r.json().items as { id: string; sourceFormat: string }[]).find(
      (i) => i.id === item,
    );
    expect(view?.sourceFormat).toBe("claude-code");
  });

  it("a claude-code version's platform skills record source_format; a stored pinned flag suggests nothing", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    // suggest_pinned stays in the table but nothing writes it any more (skills default-on)
    expect(await versionsOf()).toEqual([
      { name: "brainstorming", version: 1, source_format: "claude-code", suggest_pinned: false },
      {
        name: "using-superpowers",
        version: 1,
        source_format: "claude-code",
        suggest_pinned: false,
      },
    ]);
  });

  it("an update that only moves the stored pinned flag changes nothing", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    // 1.1.0: the same files, the old flag moved to brainstorming
    await seedSuperpowers({ version: "1.1.0", addTo: item, legacyPinned: ["brainstorming"] });
    expect(await updateTo(item, "1.1.0")).toEqual(["same", "same"]);
    expect(await versionsOf()).toEqual([
      { name: "brainstorming", version: 1, source_format: "claude-code", suggest_pinned: false },
      {
        name: "using-superpowers",
        version: 1,
        source_format: "claude-code",
        suggest_pinned: false,
      },
    ]);
  });

  it("an update to new files writes new versions, none with a pinned suggestion", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    await seedSuperpowers({ version: "2.0.0", addTo: item });
    expect(await updateTo(item, "2.0.0")).toEqual(["upgrade", "upgrade"]);
    expect((await versionsOf()).map((v) => [v.name, v.version, v.suggest_pinned])).toEqual([
      ["brainstorming", 1, false],
      ["brainstorming", 2, false],
      ["using-superpowers", 1, false],
      ["using-superpowers", 2, false],
    ]);
  });

  it("GET skills returns plugin, sourceFormat and builtin, and no pinning fields", async () => {
    const item = await seedSuperpowers();
    await installOk(item);
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/skills` });
    expect(r.statusCode, r.body).toBe(200);
    const skills = r.json().skills as Record<string, unknown>[];
    expect(skills).toMatchObject([
      { name: "brainstorming", plugin: "superpowers", sourceFormat: "claude-code", builtin: false },
      {
        name: "using-superpowers",
        plugin: "superpowers",
        sourceFormat: "claude-code",
        builtin: false,
      },
    ]);
    for (const s of skills) {
      expect(s).not.toHaveProperty("suggestPinned");
      expect(s).not.toHaveProperty("entryBytes");
      expect(s).not.toHaveProperty("tokenEstimate");
    }
  });
});

describe("a platform component updated on its own (spec §7.2)", () => {
  it("a skill zip becomes the next version: plugin kept, updated_on_own, served in orgs at once, the next update marks it", async () => {
    const item = await importKit();
    const alpha = await skillOf("alpha");
    await onEverywhere("platform_skills", alpha.id);
    const zip = makeZip([
      { name: "SKILL.md", data: SKILL_MD("alpha", "Alpha, tuned by the admin.") },
      { name: "notes.txt", data: "hello\n" },
    ]);

    const r = await uploadSkill(alpha.id, zip);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({ kind: "skill", id: alpha.id, name: "alpha", version: 2 });

    const now = await skillOf("alpha");
    expect(now).toMatchObject({
      current_version: 2,
      plugin_name: "kit",
      catalog_item_id: item,
      scope_mode: "own",
      description: "Alpha, tuned by the admin.",
    });
    const v2 = await env.db
      .selectFrom("platform_skill_versions")
      .selectAll()
      .where("skill_id", "=", alpha.id)
      .where("version", "=", 2)
      .executeTakeFirstOrThrow();
    expect(v2).toMatchObject({
      updated_on_own: true,
      catalog_version: null,
      created_by: env.rootId,
      // a fresh prefix per uploaded version (ruling P3-45)
      object_prefix: expect.stringMatching(
        new RegExp(`^platform/skills/${alpha.id}/2-[0-9a-f-]{36}/$`),
      ),
    });
    expect(await readText(`${v2.object_prefix}notes.txt`)).toBe("hello\n");
    // version 1 is untouched
    const v1 = await env.db
      .selectFrom("platform_skill_versions")
      .select(["updated_on_own", "catalog_version"])
      .where("skill_id", "=", alpha.id)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    expect(v1).toEqual({ updated_on_own: false, catalog_version: "1.0.0" });
    // served in the org at once
    const usable = (await usableSkills(env.db, env.orgId)).find((s) => s.name === "alpha");
    expect(usable).toMatchObject({ id: alpha.id, version: 2, origin: "platform" });
    expect(await auditActions(env)).toContain("component.version_uploaded");

    // the next plugin update preview marks it and the confirm moves it to the plugin's version
    const p = await previewV2(item);
    expect(p.components.find((c) => c.name === "alpha")).toMatchObject({
      id: alpha.id,
      change: "upgrade",
      updatedOnOwn: true,
    });
    const c = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${item}/update`,
      payload: { version: "2.0.0", diffHash: p.diffHash },
    });
    expect(c.statusCode, c.body).toBe(200);
    const moved = await env.db
      .selectFrom("platform_skill_versions")
      .select(["version", "catalog_version", "updated_on_own"])
      .where("skill_id", "=", alpha.id)
      .orderBy("version")
      .execute();
    expect(moved.at(-1)).toEqual({ version: 3, catalog_version: "2.0.0", updated_on_own: false });
  });

  it("an agent template file becomes the next version, likewise", async () => {
    const item = await importKit();
    const reviewer = await templateOf("reviewer");
    await onEverywhere("platform_agent_templates", reviewer.id);

    const r = await uploadTemplate(reviewer.id, reviewerMd("Review it twice."));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({
      kind: "agent_template",
      id: reviewer.id,
      name: "reviewer",
      version: 2,
    });
    const now = await templateOf("reviewer");
    expect(now).toMatchObject({ current_version: 2, plugin_name: "kit", catalog_item_id: item });
    const v2 = await env.db
      .selectFrom("platform_agent_template_versions")
      .selectAll()
      .where("template_id", "=", reviewer.id)
      .where("version", "=", 2)
      .executeTakeFirstOrThrow();
    expect(v2).toMatchObject({
      updated_on_own: true,
      catalog_version: null,
      created_by: env.rootId,
    });
    expect(await readText(`${v2.object_prefix}reviewer.md`)).toContain("Review it twice.");
    const t = (await usableTemplates(env.db, env.orgId)).find((x) => x.name === "reviewer");
    expect(t).toMatchObject({ id: reviewer.id, version: 2, origin: "platform" });
    expect(t?.template.instructions).toContain("Review it twice.");

    // the next update (a 2.0.0 with the template changed again) marks it
    const p = await previewV2(item, "Review it thrice.");
    expect(
      p.components.find((c) => c.kind === "agent_template" && c.name === "reviewer"),
    ).toMatchObject({
      change: "upgrade",
      updatedOnOwn: true,
    });
  });

  it("refuses a changed name, an invalid package, a non-super-admin and an unknown component", async () => {
    await importKit();
    const alpha = await skillOf("alpha");
    const reviewer = await templateOf("reviewer");

    const renamed = await uploadSkill(
      alpha.id,
      makeZip([{ name: "SKILL.md", data: SKILL_MD("beta") }]),
    );
    expect(renamed.statusCode, renamed.body).toBe(400);
    expect(renamed.json().error.code).toBe("validation_failed");
    const bad = await uploadSkill(alpha.id, makeZip([{ name: "notes.txt", data: "x" }]));
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe("skill.invalid_package");
    const tRenamed = await uploadTemplate(
      reviewer.id,
      reviewerMd("x").replace("name: reviewer", "name: other"),
    );
    expect(tRenamed.statusCode, tRenamed.body).toBe(400);
    const tBad = await uploadTemplate(reviewer.id, "no frontmatter");
    expect(tBad.statusCode, tBad.body).toBe(400);
    const nope = await uploadTemplate("missing", reviewerMd("x"));
    expect(nope.statusCode, nope.body).toBe(404);
    expect(nope.json().error.code).toBe("component.not_found");
    const notAdmin = await uploadTemplate(reviewer.id, reviewerMd("x"), env.boss);
    expect(notAdmin.statusCode, notAdmin.body).toBe(403);
    const notAdminZip = await uploadSkill(
      alpha.id,
      makeZip([{ name: "SKILL.md", data: SKILL_MD("alpha") }]),
      env.boss,
    );
    expect([401, 403]).toContain(notAdminZip.statusCode);

    expect((await skillOf("alpha")).current_version).toBe(1);
    expect((await templateOf("reviewer")).current_version).toBe(1);
  });

  it("GET …/versions lists a component's versions newest first, with the catalog version and the updated-on-own flag", async () => {
    await importKit();
    const alpha = await skillOf("alpha");
    const reviewer = await templateOf("reviewer");
    const up = await uploadSkill(
      alpha.id,
      makeZip([{ name: "SKILL.md", data: SKILL_MD("alpha", "Alpha 1.1.") }]),
    );
    expect(up.statusCode, up.body).toBe(201);
    const versions = (kind: string, id: string, req = env.root) =>
      req({ method: "GET", url: `/api/v1/admin/components/${kind}/${id}/versions` });

    const s = await versions("skill", alpha.id);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().versions).toMatchObject([
      { version: "2", catalogVersion: null, updatedOnOwn: true },
      { version: "1", catalogVersion: "1.0.0", updatedOnOwn: false },
    ]);
    expect(typeof s.json().versions[0].createdAt).toBe("string");
    const a = await versions("agent_template", reviewer.id);
    expect(a.json().versions).toMatchObject([
      { version: "1", catalogVersion: "1.0.0", updatedOnOwn: false },
    ]);
    expect((await versions("skill", "missing")).json().error.code).toBe("component.not_found");
    expect((await versions("skill", alpha.id, env.boss)).statusCode).toBe(403);
  });
});

describe("platform components in the import's transaction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("a failure writing platform components rolls the import back", async () => {
    const p = await prepare();
    failPlatformWrite();
    const c = await confirm(p);
    expect(c.statusCode, c.body).toBe(500);
    // nothing of the import committed: no item, no version, no platform rows; the staging stays
    expect(await kitItem()).toBeUndefined();
    expect(await env.db.selectFrom("catalog_item_versions").select("item_id").execute()).toEqual(
      [],
    );
    expect(await env.db.selectFrom("platform_skills").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("platform_agent_templates").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("platform_connector_templates").select("id").execute()).toEqual(
      [],
    );
    expect(
      await env.db
        .selectFrom("plugin_import_staging")
        .select("id")
        .where("id", "=", p.stagingId)
        .executeTakeFirst(),
    ).toEqual({ id: p.stagingId });
  });

  it("retrying the import after that failure succeeds and writes no duplicate objects", async () => {
    const first = await prepare();
    failPlatformWrite();
    expect((await confirm(first)).statusCode).toBe(500);
    // the files were copied before the transaction: they stay, keyed by their content
    const copied = await platformObjects();
    // alpha and beta (SKILL.md and scripts/run.py each), the reviewer template
    expect(copied.length).toBe(5);

    // the same staging confirmed again
    const again = await confirm(first);
    expect(again.statusCode, again.body).toBe(201);
    expect(await platformObjects()).toEqual(copied);
    // every object is one a version row references
    const prefixes = await referencedPrefixes();
    expect(prefixes).toHaveLength(3);
    for (const key of copied) expect(prefixes.some((p) => key.startsWith(p))).toBe(true);

    // a fresh prepare of the same content after a failure reuses the objects too
    await resetOrgCatalog(env);
    const before = await prepare();
    failPlatformWrite();
    expect((await confirm(before)).statusCode).toBe(500);
    const copiedAgain = await platformObjects();
    const fresh = await prepare();
    const c = await confirm(fresh);
    expect(c.statusCode, c.body).toBe(201);
    expect(await platformObjects()).toEqual(copiedAgain);
  });

  it("an imported item has its platform rows when the import returns", async () => {
    const itemId = await importPlugin(env, await kit());
    expect(await kitItem()).toEqual({ id: itemId, platform_synced_version: "1.0.0" });
    const names = async (table: "platform_skills" | "platform_agent_templates") =>
      (
        await env.db
          .selectFrom(table)
          .select("name")
          .where("catalog_item_id", "=", itemId)
          .orderBy("name")
          .execute()
      ).map((r) => r.name);
    expect(await names("platform_skills")).toEqual(["alpha", "beta"]);
    expect(await names("platform_agent_templates")).toEqual(["reviewer"]);
    expect(
      (
        await env.db
          .selectFrom("platform_connector_templates")
          .select("template_id")
          .where("catalog_item_id", "=", itemId)
          .execute()
      ).map((r) => r.template_id),
    ).toEqual(["kit-mcp"]);
  });
});
