import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import {
  PLATFORM_MIGRATION_JOB,
  PlatformMigration,
  type PlatformMigrationStats,
  renamedSkillName,
} from "../../src/catalog/platform-migration.js";
import { skillsChangeText } from "../../src/runtime/context/skills.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { skillVersionsById, usableSkills } from "../../src/skills/usable.js";
import { createOrg, enableConnectorExtensions } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  importPlugin,
  legacyCopies,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  startOrgEnv,
} from "./org-env.js";
import { bundlePlugin, mcpTemplate, skillFiles } from "./packages.js";

/**
 * Plugin scope phase 2, Task 5: the migration of org copies to platform components (spec §6
 * "Migration of what exists", §13.5). Items without platform rows get them at the highest
 * installed version; org copies link to them (pinned when their content differs; a copy whose
 * platform component is not on in its org stays unlinked until it is, ruling P2-18); an org skill of the org's own whose name a platform skill on
 * in the org has is renamed, with an inbox notice and the platform skill switched off there;
 * connectors link to their platform template. A second run changes nothing.
 */

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("org_notices").execute();
  await env.db.deleteFrom("platform_migration_runs").execute();
});

const reviewerMd = (body = "Review the change.") =>
  `---\nname: reviewer\ndescription: Reviews kit work.\n---\n${body}\n`;

/** Plugin `kit`: skills alpha and beta, agent template reviewer, connector template kit-mcp. */
const kit = (version: string, o: { alpha?: string; reviewer?: string } = {}) =>
  bundlePlugin({
    name: "kit",
    version,
    skills: ["beta"],
    templates: { "kit-mcp": mcpTemplate() },
    files: {
      ...skillFiles("alpha", SKILL_MD("alpha", o.alpha ?? "Alpha things.")),
      "agents/reviewer.md": reviewerMd(o.reviewer),
    },
  });

const connectorConfig = () => ({
  connectors: {
    "kit-mcp": { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } },
  },
});

async function installIn(orgId: string, itemId: string, version: string): Promise<void> {
  const r = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/catalog/${itemId}/install`,
    payload: connectorConfig(),
  });
  expect(r.statusCode, r.body).toBe(201);
  // an org installs the platform version (ruling P2-17); before phase 2 orgs could be on others
  await env.db
    .updateTable("plugin_installs")
    .set({ version })
    .where("org_id", "=", orgId)
    .where("item_id", "=", itemId)
    .execute();
  // the org copies an install wrote before phase 2: what the migration links
  await legacyCopies(env, orgId, itemId);
}

/** Drops the platform rows (the state before phase 2, or an import whose sync failed). */
async function dropPlatformRows(): Promise<void> {
  await env.db.deleteFrom("platform_skills").execute();
  await env.db.deleteFrom("platform_agent_templates").execute();
  await env.db.deleteFrom("platform_connector_templates").execute();
  await env.db.updateTable("catalog_items").set({ platform_synced_version: null }).execute();
}

const run = (): Promise<PlatformMigrationStats> => env.k.app.get(PlatformMigration).runOnce();

const orgSkills = (orgId: string) =>
  env.db
    .selectFrom("skills")
    .select(["id", "name", "current_version", "platform_skill_id", "pinned_version"])
    .where("org_id", "=", orgId)
    .where("scope", "=", "org")
    .where("deleted_at", "is", null)
    .orderBy("name")
    .execute();

const platformSkill = (name: string) =>
  env.db
    .selectFrom("platform_skills as p")
    .innerJoin("platform_skill_versions as v", (j) =>
      j.onRef("v.skill_id", "=", "p.id").onRef("v.version", "=", "p.current_version"),
    )
    .select(["p.id", "p.current_version", "v.catalog_version"])
    .where("p.name", "=", name)
    .where("p.deleted_at", "is", null)
    .executeTakeFirstOrThrow();

const platformTemplate = () =>
  env.db
    .selectFrom("platform_agent_templates")
    .select(["id"])
    .where("name", "=", "reviewer")
    .executeTakeFirstOrThrow();

const orgTemplate = (orgId: string) =>
  env.db
    .selectFrom("agent_templates")
    .select(["id", "current_version", "platform_template_id", "pinned_version"])
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();

/** Makes the org's skill `name` the org's own, as a same-name upload does (no provenance). */
async function resetProvenance(orgId: string, name: string): Promise<string> {
  const s = await env.db
    .updateTable("skills")
    .set({ catalog_item_id: null, catalog_version: null })
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .returning(["id", "current_version"])
    .executeTakeFirstOrThrow();
  await env.db
    .updateTable("skill_versions")
    .set({ catalog_item_id: null, catalog_version: null })
    .where("skill_id", "=", s.id)
    .where("version", "=", s.current_version)
    .execute();
  return s.id;
}

type InboxItem = { type: string; id: string; notice?: { skillRenamed: Record<string, unknown> } };

const inboxOf = async (req: OrgEnv["boss"], orgId: string): Promise<InboxItem[]> => {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/inbox` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: InboxItem[] }).items;
};

const noChange: Omit<PlatformMigrationStats, "itemsSynced"> = {
  itemsFailed: [],
  skillsLinked: 0,
  skillsPinned: 0,
  skillsRenamed: 0,
  templatesLinked: 0,
  templatesPinned: 0,
  connectorsLinked: 0,
};

describe("renamedSkillName and the rename notice (pure)", () => {
  it("appends -org, then -org-2 …, shortening the base to stay a valid skill name", () => {
    expect(renamedSkillName("pdf", new Set())).toBe("pdf-org");
    expect(renamedSkillName("pdf", new Set(["pdf-org"]))).toBe("pdf-org-2");
    expect(renamedSkillName("pdf", new Set(["pdf-org", "pdf-org-2"]))).toBe("pdf-org-3");
    const long = `${"a".repeat(60)}-bc`;
    const got = renamedSkillName(long, new Set());
    expect(got.length).toBeLessThanOrEqual(64);
    expect(got).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-org$/);
  });

  it("a skill renamed under its id reads as the old name removed and the new name added", () => {
    const s = (name: string) => ({
      id: "s1",
      name,
      description: "Use it.",
      version: 1,
      source: "skills/s1/1/",
    });
    const text = skillsChangeText([s("pdf")], [s("pdf-org")]);
    expect(text).toContain("New skills");
    expect(text).toContain("- pdf-org: Use it.");
    expect(text).toContain("Removed skills (no longer available; do not use them): pdf");
    expect(text).not.toContain("Updated skills");
  });
});

describe("platform components migration", () => {
  it("writes the platform rows of an item that has none and links the org copies, connectors included; a second run is a no-op", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    await dropPlatformRows();

    const stats = await run();
    expect(stats).toEqual({
      ...noChange,
      itemsSynced: ["kit@1.0.0"],
      skillsLinked: 2,
      templatesLinked: 1,
      connectorsLinked: 1,
    });

    const alpha = await platformSkill("alpha");
    const beta = await platformSkill("beta");
    expect(alpha.catalog_version).toBe("1.0.0");
    const item = await env.db
      .selectFrom("catalog_items")
      .select("platform_synced_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(item.platform_synced_version).toBe("1.0.0");
    expect(await orgSkills(env.orgId)).toEqual([
      expect.objectContaining({ name: "alpha", platform_skill_id: alpha.id, pinned_version: null }),
      expect.objectContaining({ name: "beta", platform_skill_id: beta.id, pinned_version: null }),
    ]);
    expect(await orgTemplate(env.orgId)).toMatchObject({
      platform_template_id: (await platformTemplate()).id,
      pinned_version: null,
    });
    const tpl = await env.db
      .selectFrom("platform_connector_templates")
      .select("id")
      .executeTakeFirstOrThrow();
    const connectors = await env.db
      .selectFrom("connectors")
      .select("platform_template_id")
      .where("org_id", "=", env.orgId)
      .execute();
    expect(connectors).toEqual([{ platform_template_id: tpl.id }]);
    // the org now sees the platform skills (its linked copies resolve to them)
    expect((await usableSkills(env.db, env.orgId)).map((s) => [s.name, s.origin])).toEqual([
      ["alpha", "platform"],
      ["beta", "platform"],
    ]);

    expect(await run()).toEqual({ ...noChange, itemsSynced: [] });
    const runs = await env.db
      .selectFrom("platform_migration_runs")
      .select(["finished_at"])
      .execute();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.finished_at !== null)).toBe(true);
  });

  it("a run stops early when its signal aborts (the stop, or a lost run lock) and records no run", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    await dropPlatformRows();
    const stopped = new AbortController();
    stopped.abort();
    const stats = await env.k.app.get(PlatformMigration).runOnce(stopped.signal);
    expect(stats).toEqual({ ...noChange, itemsSynced: [] });
    expect(await env.db.selectFrom("platform_migration_runs").select("id").execute()).toEqual([]);
    // the next run does the work
    expect(await run()).toMatchObject({ itemsSynced: ["kit@1.0.0"], skillsLinked: 2 });
  });

  it("a failed sync after an import enqueues a run of the job soon (one per item), which writes the rows", async () => {
    const sync = vi
      .spyOn(PlatformComponents.prototype, "syncFromVersion")
      .mockRejectedValueOnce(new Error("storage blip"));
    try {
      const itemId = await importPlugin(env, await kit("1.0.0"));
      const queue = env.k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME));
      const job = await queue.getJob(`${PLATFORM_MIGRATION_JOB}-retry-${itemId}`);
      expect(job?.name).toBe(PLATFORM_MIGRATION_JOB);
      expect(job?.opts.delay).toBeGreaterThan(0);
      expect(job?.opts.delay).toBeLessThanOrEqual(15 * 60_000);
      await job?.remove();
      expect(await env.db.selectFrom("platform_skills").select("id").execute()).toEqual([]);
      expect(await run()).toMatchObject({ itemsSynced: ["kit@1.0.0"] });
    } finally {
      sync.mockRestore();
    }
  });

  it("orgs on different versions: the platform takes the highest installed one; a copy whose content differs is pinned to its version", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await importPlugin(env, await kit("1.1.0", { alpha: "Alpha 1.1.", reviewer: "Review v2." }));
    const orgB = await createOrg(env.root, "Beta Org");
    await enableConnectorExtensions(env.k, orgB);
    await installIn(env.orgId, itemId, "1.0.0");
    await installIn(orgB, itemId, "1.1.0");
    await dropPlatformRows();

    const stats = await run();
    expect(stats).toMatchObject({
      itemsSynced: ["kit@1.1.0"],
      skillsLinked: 4,
      skillsPinned: 1,
      templatesLinked: 2,
      templatesPinned: 1,
      connectorsLinked: 2,
    });
    const alpha = await platformSkill("alpha");
    expect(alpha.catalog_version).toBe("1.1.0");
    // org A (1.0.0): alpha differs from 1.1.0 (pinned to its own version), beta is the same
    const a = await orgSkills(env.orgId);
    expect(a).toEqual([
      expect.objectContaining({ name: "alpha", platform_skill_id: alpha.id, pinned_version: 1 }),
      expect.objectContaining({ name: "beta", pinned_version: null }),
    ]);
    expect((await orgTemplate(env.orgId)).pinned_version).toBe(1);
    // org B (1.1.0): nothing differs
    expect((await orgSkills(orgB)).map((s) => s.pinned_version)).toEqual([null, null]);
    expect((await orgTemplate(orgB)).pinned_version).toBeNull();
    // the pinned copy keeps serving its own version under its id
    const served = await skillVersionsById(env.db, env.orgId, [a[0]?.id as string]);
    expect(served.get(a[0]?.id as string)).toMatchObject({ origin: "org", version: 1 });
  });

  it("a copy whose platform skill is not on in its org stays the org's own until it is on (ruling P2-18)", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    // the plugin is no longer on in the org (as after an uninstall that kept skills agents use)
    await env.db.updateTable("plugin_installs").set({ status: "failed" }).execute();

    // a linked copy (pinned or not) follows its platform skill: linked now, it would disappear
    const stats = await run();
    expect(stats).toMatchObject({ itemsSynced: [], skillsLinked: 0, skillsPinned: 0 });
    expect(
      (await orgSkills(env.orgId)).map((s) => [s.name, s.platform_skill_id, s.pinned_version]),
    ).toEqual([
      ["alpha", null, null],
      ["beta", null, null],
    ]);
    expect((await usableSkills(env.db, env.orgId)).map((s) => [s.name, s.origin])).toEqual([
      ["alpha", "org"],
      ["beta", "org"],
    ]);

    // on again: the next run links them
    await env.db.updateTable("plugin_installs").set({ status: "installed" }).execute();
    expect(await run()).toMatchObject({ skillsLinked: 2 });
    expect((await orgSkills(env.orgId)).every((s) => s.platform_skill_id !== null)).toBe(true);
  });

  it("an org skill of the org's own named like a platform skill on in the org is renamed, noticed and the platform skill switched off there; agents keep it by id", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    const own = await resetProvenance(env.orgId, "alpha");
    const alpha = await platformSkill("alpha");

    const stats = await run();
    expect(stats).toMatchObject({ skillsRenamed: 1, skillsLinked: 1 });
    expect((await orgSkills(env.orgId)).map((s) => [s.id, s.name, s.platform_skill_id])).toEqual([
      [own, "alpha-org", null],
      [expect.any(String), "beta", expect.any(String)],
    ]);
    // an agent that selects the skill by id gets it under its new name
    expect((await skillVersionsById(env.db, env.orgId, [own])).get(own)).toMatchObject({
      name: "alpha-org",
      origin: "org",
    });
    expect(
      await env.db
        .selectFrom("component_org_switches")
        .select(["kind", "component_id", "enabled"])
        .where("org_id", "=", env.orgId)
        .execute(),
    ).toEqual([{ kind: "skill", component_id: alpha.id, enabled: false }]);
    // the org sees its renamed skill and the platform beta; the platform alpha is off there
    expect((await usableSkills(env.db, env.orgId)).map((s) => [s.name, s.origin])).toEqual([
      ["alpha-org", "org"],
      ["beta", "platform"],
    ]);
    const audit = await env.db
      .selectFrom("audit_events")
      .select(["action", "target"])
      .where("action", "=", "skill.renamed")
      .execute();
    expect(audit).toEqual([{ action: "skill.renamed", target: own }]);

    // the org admins get the notice; members do not
    const items = (await inboxOf(env.boss, env.orgId)).filter((i) => i.type === "skill_renamed");
    expect(items).toHaveLength(1);
    expect(items[0]?.notice?.skillRenamed).toEqual({
      skillId: own,
      from: "alpha",
      to: "alpha-org",
      platformSkillId: alpha.id,
      plugin: "kit",
    });
    expect((await inboxOf(env.mem, env.orgId)).some((i) => i.type === "skill_renamed")).toBe(false);
    const noticeId = items[0]?.id as string;
    const byMember = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/inbox/notices/${noticeId}/dismiss`,
    });
    expect(byMember.statusCode).toBe(404);
    expect(byMember.json().error.code).toBe("inbox.notice_not_found");

    // a second run renames nothing again
    expect(await run()).toEqual({ ...noChange, itemsSynced: [] });
    expect(await env.db.selectFrom("org_notices").select("id").execute()).toHaveLength(1);

    const dismissed = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/inbox/notices/${noticeId}/dismiss`,
    });
    expect(dismissed.statusCode, dismissed.body).toBe(204);
    expect((await inboxOf(env.boss, env.orgId)).some((i) => i.type === "skill_renamed")).toBe(
      false,
    );
    const again = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/inbox/notices/${noticeId}/dismiss`,
    });
    expect(again.statusCode).toBe(404);
  });

  it("an org skill of the org's own whose platform namesake is not on in the org stays as it is", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    await resetProvenance(env.orgId, "alpha");
    await env.db.updateTable("plugin_installs").set({ status: "failed" }).execute();

    const stats = await run();
    expect(stats.skillsRenamed).toBe(0);
    expect((await orgSkills(env.orgId)).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(await env.db.selectFrom("org_notices").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("component_org_switches").select("org_id").execute()).toEqual(
      [],
    );
  });

  it("the new name skips names the org uses; a switch the org already has is kept", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    const own = await resetProvenance(env.orgId, "alpha");
    const alpha = await platformSkill("alpha");
    await env.db
      .insertInto("component_org_switches")
      .values({ kind: "skill", component_id: alpha.id, org_id: env.orgId, enabled: true })
      .execute();
    await env.db
      .insertInto("skills")
      .values({
        id: "taken-name",
        org_id: env.orgId,
        scope: "org",
        agent_id: null,
        name: "alpha-org",
        description: "d",
        current_version: 1,
        created_by: null,
      })
      .execute();
    await env.db
      .insertInto("skill_versions")
      .values({
        skill_id: "taken-name",
        version: 1,
        manifest: JSON.stringify({ name: "alpha-org", description: "d", files: [] }),
        object_prefix: "skills/taken-name/1/",
        created_by: null,
      })
      .execute();

    expect((await run()).skillsRenamed).toBe(1);
    const renamed = await env.db
      .selectFrom("skills")
      .select("name")
      .where("id", "=", own)
      .executeTakeFirstOrThrow();
    expect(renamed.name).toBe("alpha-org-2");
    expect(
      await env.db
        .selectFrom("component_org_switches")
        .select("enabled")
        .where("org_id", "=", env.orgId)
        .execute(),
    ).toEqual([{ enabled: true }]);
  });

  it("an item whose platform components were removed is not synced again", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    // the import's sync recorded the version
    expect(
      (
        await env.db
          .selectFrom("catalog_items")
          .select("platform_synced_version")
          .where("id", "=", itemId)
          .executeTakeFirstOrThrow()
      ).platform_synced_version,
    ).toBe("1.0.0");
    const now = new Date();
    await env.db.updateTable("platform_skills").set({ deleted_at: now }).execute();
    await env.db.updateTable("platform_agent_templates").set({ deleted_at: now }).execute();
    await env.db.updateTable("platform_connector_templates").set({ deleted_at: now }).execute();

    expect(await run()).toEqual({ ...noChange, itemsSynced: [] });
    const live = await env.db
      .selectFrom("platform_skills")
      .select("id")
      .where("deleted_at", "is", null)
      .execute();
    expect(live).toEqual([]);
  });

  it("a clash that appears after the first run is not renamed (rename is one-shot)", async () => {
    // the first run (nothing to do) sets the cutoff
    await run();
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    await resetProvenance(env.orgId, "alpha");

    const stats = await run();
    expect(stats.skillsRenamed).toBe(0);
    expect((await orgSkills(env.orgId)).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(await env.db.selectFrom("org_notices").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("component_org_switches").select("org_id").execute()).toEqual(
      [],
    );
  });

  it("a pre-existing org skill whose platform namesake is switched on after the first run is not renamed, only warned about", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await installIn(env.orgId, itemId, "1.0.0");
    await resetProvenance(env.orgId, "alpha");
    // the plugin is not on in the org during the first run: no clash then
    await env.db.updateTable("plugin_installs").set({ status: "failed" }).execute();
    expect((await run()).skillsRenamed).toBe(0);
    // the platform alpha becomes on in the org after the first finished run
    await env.db.updateTable("plugin_installs").set({ status: "installed" }).execute();

    const job = env.k.app.get(PlatformMigration);
    const warn = vi.spyOn(job.log, "warn");
    try {
      expect((await run()).skillsRenamed).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        "org skill shares its name with a platform skill; not renamed after the migration",
        expect.objectContaining({ orgId: env.orgId, name: "alpha" }),
      );
    } finally {
      warn.mockRestore();
    }
    expect((await orgSkills(env.orgId)).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(await env.db.selectFrom("org_notices").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("component_org_switches").select("org_id").execute()).toEqual(
      [],
    );
  });
});
