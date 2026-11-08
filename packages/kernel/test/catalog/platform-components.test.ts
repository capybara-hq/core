import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { SKILL_MD } from "../skills/zip.js";
import { importPlugin, type OrgEnv, resetOrgCatalog, startOrgEnv } from "./org-env.js";
import { bundlePlugin, mcpTemplate, skillFiles } from "./packages.js";

/**
 * Plugin scope phase 2, Task 2: the platform components of a plugin version. The confirm that
 * creates a catalog item writes one platform row per skill, agent template and connector template
 * (files under `deployment/platform/…`); a new version of the item leaves them alone (updates go
 * through the platform plugin update); `syncFromVersion` adds a version only when content changed.
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
        object_prefix: `platform/skills/${s.id}/1-1.0.0/`,
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
      object_prefix: `platform/agent-templates/${tpl?.id}/1-1.0.0/`,
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

  it("syncFromVersion adds a version only for changed content", async () => {
    const itemId = await importPlugin(env, await kit("1.0.0"));
    await importPlugin(
      env,
      await kit("1.1.0", {
        alphaMd: SKILL_MD("alpha", "Alpha, changed."),
        reviewer: reviewerMd("Review harder."),
      }),
    );
    const sync = env.k.app.get(PlatformComponents);
    const r = await sync.syncFromVersion(itemId, "1.1.0", { initial: false });
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
      object_prefix: `platform/skills/${alpha?.id}/2-1.1.0/`,
    });
    expect(await readText(`${alpha?.object_prefix}SKILL.md`)).toContain("Alpha, changed.");
    // the first version's files stay
    expect(await readText(`platform/skills/${alpha?.id}/1-1.0.0/SKILL.md`)).toContain(
      "Alpha things.",
    );
    const beta = (await skillRows()).find((s) => s.name === "beta");
    expect(beta?.current_version).toBe(1);

    // the same version again changes nothing
    expect(await sync.syncFromVersion(itemId, "1.1.0", { initial: false })).toEqual({
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
