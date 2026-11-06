import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usableTemplates } from "../../src/agents/templates.js";
import { PluginScopeSync } from "../../src/catalog/scope-sync.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { usableSkills } from "../../src/skills/usable.js";
import { createOrg } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setBuiltin,
  setScope,
  startOrgEnv,
} from "./org-env.js";

/**
 * Plugin scope phase 2, Task 6: installs no longer copy skills or agent templates into the org (the
 * platform components are on there while the plugin is); each component has its own scope or
 * follows its plugin's; an org admin switches one component off in the org; names stay unique in
 * an org's usable set (rule 10).
 */

let env: OrgEnv;
let org2: string;

beforeAll(async () => {
  env = await startOrgEnv();
  org2 = await createOrg(env.root, "Beta");
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
});

const skillNames = async (orgId: string) =>
  (await usableSkills(env.db, orgId)).map((s) => `${s.origin}:${s.name}`);

/** A skills-only plugin `crm` with skill `pdf-tools`, installed in both orgs. */
async function crmInBoth(): Promise<{ itemId: string; skillId: string }> {
  const itemId = await seedPlugin(env, { name: "crm", skills: ["pdf-tools"], templates: false });
  expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
  const r = await env.root({
    method: "POST",
    url: `/api/v1/orgs/${org2}/catalog/${itemId}/install`,
    payload: {},
  });
  expect(r.statusCode, r.body).toBe(201);
  const p = await env.db
    .selectFrom("platform_skills")
    .select("id")
    .where("name", "=", "pdf-tools")
    .executeTakeFirstOrThrow();
  return { itemId, skillId: p.id };
}

const sw = (orgId: string, req: OrgEnv["boss"], id: string, body: Record<string, unknown>) =>
  req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/components/skill/${id}/switch`,
    payload: body,
  });

async function agentUsing(skillId: string): Promise<string> {
  const r = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        skills: { orgSkills: [skillId] },
      },
      visibility: "org",
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent.id as string;
}

/** An org's own skill (no provenance), written like an upload. */
const ownSkill = (orgId: string, name: string, actor = env.rootId) => {
  const md = new TextEncoder().encode(SKILL_MD(name));
  return env.k.app.get(SkillsService).createVersionFromFiles(orgId, actor, {
    name,
    description: "Mine.",
    files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
  });
};

async function previewScope(kind: string, id: string, body: Record<string, unknown>) {
  const r = await env.root({
    method: "POST",
    url: `/api/v1/admin/components/${kind}/${id}/scope/preview`,
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe("installs of platform plugins", { timeout: 60_000 }, () => {
  it("write no org skill or agent template rows; the platform components are on while the plugin is", async () => {
    const itemId = await seedPlugin(env, {
      name: "crm",
      skills: ["pdf-tools"],
      templates: { gh: {} },
    });
    const r = await install(env.boss, env, itemId, {
      connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } } },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(await env.db.selectFrom("skills").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("agent_templates").select("id").execute()).toEqual([]);
    expect(await skillNames(env.orgId)).toEqual(["platform:pdf-tools"]);
    expect(await skillNames(org2)).toEqual([]);
    // the connector made from the platform template stays linked to it (ruling E2)
    const tpl = await env.db
      .selectFrom("platform_connector_templates")
      .select("id")
      .executeTakeFirstOrThrow();
    const c = await env.db
      .selectFrom("connectors")
      .select("platform_template_id")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(c.platform_template_id).toBe(tpl.id);
    expect(await usableTemplates(env.db, env.orgId)).toEqual([]);
  });

  it("uninstall previews the agents using a platform skill and removes no skill rows", async () => {
    const { skillId } = await crmInBoth();
    const agentId = await agentUsing(skillId);
    const install = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("org_id", "=", env.orgId)
      .executeTakeFirstOrThrow();
    const r = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${(await env.db.selectFrom("catalog_items").select("id").executeTakeFirstOrThrow()).id}/switch`,
      payload: { enabled: false },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().preview.agents).toEqual([
      { id: agentId, name: "Skilled", uses: [{ kind: "skill", ref: skillId }] },
    ]);
    expect(install.id).toBe(r.json().preview.installId);
  });
});

describe("org component switches", { timeout: 60_000 }, () => {
  it("switching a skill off in one org removes it from that org's usable set only, after a preview of its agents", async () => {
    const { skillId } = await crmInBoth();
    const agentId = await agentUsing(skillId);
    const p = await sw(env.orgId, env.boss, skillId, { enabled: false });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().preview.agents).toEqual([{ id: agentId, name: "Skilled", refs: [skillId] }]);
    expect(await skillNames(env.orgId)).toEqual(["platform:pdf-tools"]);
    const stale = await sw(env.orgId, env.boss, skillId, {
      enabled: false,
      confirm: "0".repeat(64),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("plugin.switch_stale");
    const off = await sw(env.orgId, env.boss, skillId, {
      enabled: false,
      confirm: p.json().confirm,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().component).toMatchObject({ id: skillId, on: false, switch: false });
    expect(await skillNames(env.orgId)).toEqual([]);
    expect(await skillNames(org2)).toEqual(["platform:pdf-tools"]);
    const on = await sw(env.orgId, env.boss, skillId, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(await skillNames(env.orgId)).toEqual(["platform:pdf-tools"]);
  });

  it("members cannot switch; a component of an `all` plugin or with its own `all` scope cannot be switched off", async () => {
    const { itemId, skillId } = await crmInBoth();
    expect((await sw(env.orgId, env.mem, skillId, { enabled: false })).statusCode).toBe(403);
    await setScope(env, itemId, "all");
    const locked = await sw(env.orgId, env.boss, skillId, { enabled: false });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe("plugin.scope_locked");
    await setScope(env, itemId, "optional");
    const pv = await previewScope("skill", skillId, { scope: "all" });
    const put = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/scope`,
      payload: { scope: "all", scopeHash: pv.scopeHash },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ scopeMode: "own", scope: "all" });
    const locked2 = await sw(env.orgId, env.boss, skillId, { enabled: false });
    expect(locked2.json().error.code).toBe("plugin.scope_locked");
    const unknown = await sw(env.orgId, env.boss, "nope", { enabled: true });
    expect(unknown.statusCode).toBe(404);
  });

  it("switching a skill on where the org has its own skill of that name: 409 plugin.skill_conflict", async () => {
    const { skillId } = await crmInBoth();
    const p = await sw(env.orgId, env.boss, skillId, { enabled: false });
    await sw(env.orgId, env.boss, skillId, { enabled: false, confirm: p.json().confirm });
    // the org's own skill of that name is refused while the platform skill is offered (rule 10)
    await expect(ownSkill(env.orgId, "pdf-tools", env.bossId)).rejects.toMatchObject({
      code: "plugin.skill_conflict",
    });
    // one written before the platform skill was offered (seeded directly) blocks switching it on
    await env.db
      .insertInto("skills")
      .values({
        id: "00000000-0000-4000-8000-000000000001",
        org_id: env.orgId,
        scope: "org",
        agent_id: null,
        name: "pdf-tools",
        description: "Mine.",
        current_version: 1,
      })
      .execute();
    await env.db
      .insertInto("skill_versions")
      .values({
        skill_id: "00000000-0000-4000-8000-000000000001",
        version: 1,
        manifest: JSON.stringify({ name: "pdf-tools", description: "Mine.", files: [] }),
        object_prefix: "skills/x/",
      })
      .execute();
    const on = await sw(env.orgId, env.boss, skillId, { enabled: true });
    expect(on.statusCode).toBe(409);
    expect(on.json().error.code).toBe("plugin.skill_conflict");
  });
});

describe("component scope (super admin)", { timeout: 60_000 }, () => {
  it("own `named` scope: the preview lists the org that loses it with its agents; confirmed, it is on only in the listed org", async () => {
    const { skillId } = await crmInBoth();
    const agentId = await agentUsing(skillId);
    const pv = await previewScope("skill", skillId, { scope: "named", orgs: [org2] });
    expect(pv.affected).toEqual([
      {
        orgId: env.orgId,
        orgName: expect.any(String),
        agents: [{ id: agentId, name: "Skilled" }],
        connectorsKept: 0,
      },
    ]);
    expect(pv.conflicts).toEqual([]);
    const stale = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/scope`,
      payload: { scope: "named", orgs: [org2], scopeHash: "x" },
    });
    expect(stale.json().error.code).toBe("plugin.scope_stale");
    const put = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/scope`,
      payload: { scope: "named", orgs: [org2], scopeHash: pv.scopeHash },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ scopeMode: "own", scope: "named", orgs: [org2] });
    expect(await skillNames(env.orgId)).toEqual([]);
    expect(await skillNames(org2)).toEqual(["platform:pdf-tools"]);
    const list = await env.root({ method: "GET", url: "/api/v1/admin/components?kind=skill" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().components).toEqual([
      expect.objectContaining({
        id: skillId,
        name: "pdf-tools",
        plugin: "crm",
        owner: { kind: "platform" },
        scope: "named",
        version: "1",
        onIn: [org2],
      }),
    ]);
    // back to following the plugin
    const f = await previewScope("skill", skillId, { follow: true });
    const back = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/scope`,
      payload: { follow: true, scopeHash: f.scopeHash },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await skillNames(env.orgId)).toEqual(["platform:pdf-tools"]);
  });

  it("a scope change that would offer the skill to an org with its own skill of that name is listed and refused", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: ["pdf-tools"], templates: false });
    await setScope(env, itemId, "named", [env.orgId]);
    await ownSkill(org2, "pdf-tools");
    const p = await env.db.selectFrom("platform_skills").select("id").executeTakeFirstOrThrow();
    const pv = await previewScope("skill", p.id, { scope: "optional" });
    expect(pv.conflicts).toEqual([
      {
        orgId: org2,
        orgName: "Beta",
        name: "pdf-tools",
        skills: [expect.any(String)],
        plugins: [],
      },
    ]);
    const put = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${p.id}/scope`,
      payload: { scope: "optional", scopeHash: pv.scopeHash },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("plugin.skill_conflict");
    // the plugin's own scope change is refused the same way
    const ppv = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/scope/preview`,
      payload: { scope: "optional" },
    });
    expect(ppv.json().conflicts).toHaveLength(1);
    const pput = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/scope`,
      payload: { scope: "optional", scopeHash: ppv.json().scopeHash },
    });
    expect(pput.statusCode).toBe(409);
    expect(pput.json().error.code).toBe("plugin.skill_conflict");
  });

  it("a plugin scope change replaces the components' own scope: the preview lists them, confirming makes them follow again", async () => {
    const { itemId, skillId } = await crmInBoth();
    const agentId = await agentUsing(skillId);
    const pv = await previewScope("skill", skillId, { scope: "all" });
    const own = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/scope`,
      payload: { scope: "all", scopeHash: pv.scopeHash },
    });
    expect(own.statusCode, own.body).toBe(200);
    // narrowing the plugin to org2: org A loses the plugin and the skill (own scope replaced)
    const ppv = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/scope/preview`,
      payload: { scope: "named", orgs: [org2] },
    });
    expect(ppv.statusCode, ppv.body).toBe(200);
    expect(ppv.json().replaced).toEqual([{ kind: "skill", id: skillId, name: "pdf-tools" }]);
    expect(ppv.json().affected).toEqual([
      expect.objectContaining({ orgId: env.orgId, agents: [{ id: agentId, name: "Skilled" }] }),
    ]);
    const put = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/scope`,
      payload: { scope: "named", orgs: [org2], scopeHash: ppv.json().scopeHash },
    });
    expect(put.statusCode, put.body).toBe(200);
    const row = await env.db
      .selectFrom("platform_skills")
      .select("scope_mode")
      .where("id", "=", skillId)
      .executeTakeFirstOrThrow();
    expect(row.scope_mode).toBe("follow");
  });

  it("disabling a component previews and cuts it everywhere; enabling brings it back", async () => {
    const { skillId } = await crmInBoth();
    const pv = await previewScope("skill", skillId, { disabled: true });
    expect(pv.affected.map((a: { orgId: string }) => a.orgId).sort()).toEqual(
      [env.orgId, org2].sort(),
    );
    const noHash = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/disabled`,
      payload: { disabled: true },
    });
    expect(noHash.statusCode).toBe(400);
    const d = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/disabled`,
      payload: { disabled: true, scopeHash: pv.scopeHash },
    });
    expect(d.statusCode, d.body).toBe(200);
    expect(await skillNames(env.orgId)).toEqual([]);
    expect(await skillNames(org2)).toEqual([]);
    const e = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/disabled`,
      payload: { disabled: false },
    });
    expect(e.statusCode, e.body).toBe(200);
    expect(await skillNames(org2)).toEqual(["platform:pdf-tools"]);
    const shown = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${skillId}/shown`,
      payload: { shownToOthers: false },
    });
    expect(shown.json()).toMatchObject({ shownToOthers: false });
    expect(
      (await env.root({ method: "GET", url: "/api/v1/admin/components?kind=skill" })).statusCode,
    ).toBe(200);
    expect(
      (await env.boss({ method: "GET", url: "/api/v1/admin/components?kind=skill" })).statusCode,
    ).toBe(403);
  });
});

describe("agent save checks", { timeout: 60_000 }, () => {
  it("a linked copy whose platform skill is off in the org is refused, like the platform id", async () => {
    const { skillId } = await crmInBoth();
    const copy = "00000000-0000-4000-8000-000000000003";
    await env.db
      .insertInto("skills")
      .values({
        id: copy,
        org_id: env.orgId,
        scope: "org",
        agent_id: null,
        name: "pdf-tools",
        description: "Copy.",
        current_version: 1,
        platform_skill_id: skillId,
      })
      .execute();
    await env.db
      .insertInto("skill_versions")
      .values({
        skill_id: copy,
        version: 1,
        manifest: JSON.stringify({ name: "pdf-tools", description: "Copy.", files: [] }),
        object_prefix: "skills/copy3/",
      })
      .execute();
    const p = await sw(env.orgId, env.boss, skillId, { enabled: false });
    await sw(env.orgId, env.boss, skillId, { enabled: false, confirm: p.json().confirm });
    for (const id of [copy, skillId]) {
      const r = await env.boss({
        method: "POST",
        url: `/api/v1/orgs/${env.orgId}/agents`,
        payload: {
          definition: {
            name: "Skilled",
            instructions: "x",
            model: { provider: "model-fake", model: "fake-1" },
            skills: { orgSkills: [id] },
          },
          visibility: "org",
        },
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });
});

describe("org uploads next to platform skills", { timeout: 60_000 }, () => {
  it("an upload to the name of a linked unpinned copy pins the copy to the new version (ruling P2-4)", async () => {
    const { skillId } = await crmInBoth();
    // an org copy from an earlier install, linked by the migration
    const copy = "00000000-0000-4000-8000-000000000002";
    await env.db
      .insertInto("skills")
      .values({
        id: copy,
        org_id: env.orgId,
        scope: "org",
        agent_id: null,
        name: "pdf-tools",
        description: "Copy.",
        current_version: 1,
        platform_skill_id: skillId,
      })
      .execute();
    await env.db
      .insertInto("skill_versions")
      .values({
        skill_id: copy,
        version: 1,
        manifest: JSON.stringify({ name: "pdf-tools", description: "Copy.", files: [] }),
        object_prefix: "skills/copy/",
      })
      .execute();
    const r = await ownSkill(env.orgId, "pdf-tools", env.bossId);
    expect(r).toMatchObject({ version: 2, created: false });
    const row = await env.db
      .selectFrom("skills")
      .select(["pinned_version", "platform_skill_id"])
      .where("id", "=", copy)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ pinned_version: 2, platform_skill_id: skillId });
    // the org's own version wins in its usable set (same component, no clash)
    expect((await usableSkills(env.db, env.orgId)).map((s) => [s.id, s.origin])).toEqual([
      [copy, "org"],
    ]);
  });
});

/** Fix round 1: rule 10 between platform skills; connector template state (P2-6); 404s. */
describe("fix round 1", { timeout: 60_000 }, () => {
  /** Plugin `a` with skill `notes` installed in org A; plugin `b` with its own skill `notes`. */
  async function twoNotes(): Promise<{ bItem: string; bNotes: string; aNotes: string }> {
    const aItem = await seedPlugin(env, { name: "a", skills: ["notes"], templates: false });
    expect((await install(env.boss, env, aItem)).statusCode).toBe(201);
    const bItem = await seedPlugin(env, { name: "b", skills: ["notes"], templates: false });
    const ids = await env.db
      .selectFrom("platform_skills")
      .select(["id", "plugin_name"])
      .where("name", "=", "notes")
      .execute();
    return {
      bItem,
      aNotes: ids.find((r) => r.plugin_name === "a")?.id as string,
      bNotes: ids.find((r) => r.plugin_name === "b")?.id as string,
    };
  }

  it("switching on a platform skill named like another platform skill on in the org: 409", async () => {
    const { bNotes, aNotes } = await twoNotes();
    await env.db
      .updateTable("platform_skills")
      .set({ scope_mode: "own", scope: "optional" })
      .where("id", "=", bNotes)
      .execute();
    const r = await sw(env.orgId, env.boss, bNotes, { enabled: true });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("plugin.skill_conflict");
    expect(r.json().error.details[0].skills).toEqual([aNotes]);
    expect(await env.db.selectFrom("component_org_switches").select("org_id").execute()).toEqual(
      [],
    );
  });

  it("a component or plugin scope change offering a skill named like a platform skill on in the org lists the conflict and is refused", async () => {
    const { bItem, bNotes, aNotes } = await twoNotes();
    await setScope(env, bItem, "named", []);
    const pv = await previewScope("skill", bNotes, { scope: "optional" });
    expect(pv.conflicts).toEqual([
      {
        orgId: env.orgId,
        orgName: expect.any(String),
        name: "notes",
        skills: [aNotes],
        plugins: ["a"],
      },
    ]);
    const put = await env.root({
      method: "PUT",
      url: `/api/v1/admin/components/skill/${bNotes}/scope`,
      payload: { scope: "optional", scopeHash: pv.scopeHash },
    });
    expect(put.json().error.code).toBe("plugin.skill_conflict");
    const ppv = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${bItem}/scope/preview`,
      payload: { scope: "optional" },
    });
    expect(ppv.json().conflicts).toEqual([
      {
        orgId: env.orgId,
        orgName: expect.any(String),
        name: "notes",
        skills: [aNotes],
        plugins: ["a"],
      },
    ]);
    const pput = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${bItem}/scope`,
      payload: { scope: "optional", scopeHash: ppv.json().scopeHash },
    });
    expect(pput.json().error.code).toBe("plugin.skill_conflict");
  });

  it("a deployment-disabled component not offered to the org is 404 for its switch (nothing written)", async () => {
    const itemId = await seedPlugin(env, { name: "crm", skills: ["pdf-tools"], templates: false });
    await setScope(env, itemId, "named", [org2]);
    const p = await env.db.selectFrom("platform_skills").select("id").executeTakeFirstOrThrow();
    await env.db.updateTable("platform_skills").set({ disabled: true }).execute();
    for (const enabled of [true, false]) {
      const r = await sw(env.orgId, env.boss, p.id, { enabled });
      expect(r.statusCode, r.body).toBe(404);
    }
    expect(await env.db.selectFrom("component_org_switches").select("org_id").execute()).toEqual(
      [],
    );
  });

  const templateId = () =>
    env.db
      .selectFrom("platform_connector_templates")
      .select("id")
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  const tplSwitch = (enabled: boolean, confirm?: string) =>
    env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/components/connector_template/${tplId}/switch`,
      payload: { enabled, ...(confirm !== undefined && { confirm }) },
    });
  let tplId = "";
  const ghBody = {
    connectors: { gh: { endpoint: { url: "" }, credential: { token: MCP_TOKEN } } },
  };
  const liveConnectors = () =>
    env.db.selectFrom("connectors").select("id").where("deleted_at", "is", null).execute();

  it("connector templates off in the org (switch, own scope, disabled) create no connector and need no input", async () => {
    ghBody.connectors.gh.endpoint.url = env.mcp.url;
    for (const off of ["switch", "own", "disabled"] as const) {
      await resetOrgCatalog(env);
      const itemId = await seedPlugin(env, { name: "github", skills: [] });
      tplId = await templateId();
      if (off === "switch") expect((await tplSwitch(false)).statusCode).toBe(200);
      if (off === "own") {
        await env.db
          .updateTable("platform_connector_templates")
          .set({ scope_mode: "own", scope: "named" })
          .execute();
      }
      if (off === "disabled") {
        await env.db.updateTable("platform_connector_templates").set({ disabled: true }).execute();
      }
      const sync = env.k.app.get(PluginScopeSync);
      expect(await sync.needsInput(env.orgId, itemId, "1.0.0"), off).toBe(false);
      const bare = await install(env.boss, env, itemId);
      expect(bare.statusCode, `${off}: ${bare.body}`).toBe(201);
      expect(await liveConnectors(), off).toEqual([]);
    }
  });

  it("a template on in the org: needs input; switched off after the install, its connector stays and the preview counts it", async () => {
    ghBody.connectors.gh.endpoint.url = env.mcp.url;
    const itemId = await seedPlugin(env, { name: "github", skills: [] });
    tplId = await templateId();
    expect(await env.k.app.get(PluginScopeSync).needsInput(env.orgId, itemId, "1.0.0")).toBe(true);
    expect((await install(env.boss, env, itemId, ghBody)).statusCode).toBe(201);
    const [conn] = await liveConnectors();
    const linked = await env.db
      .selectFrom("connectors")
      .select("platform_template_id")
      .executeTakeFirstOrThrow();
    expect(linked.platform_template_id).toBe(tplId);
    const pv = await previewScope("connector_template", tplId, { disabled: true });
    expect(pv.affected).toEqual([
      expect.objectContaining({ orgId: env.orgId, agents: [], connectorsKept: 1 }),
    ]);
    const pre = await tplSwitch(false);
    expect(pre.statusCode, pre.body).toBe(200);
    expect(pre.json().preview).toEqual({ agents: [], connectorsKept: 1 });
    const off = await tplSwitch(false, pre.json().confirm);
    expect(off.statusCode, off.body).toBe(200);
    expect(await liveConnectors()).toEqual([conn]);
  });
});

describe("the admin component list: builtin and org-owned (Task 9 fix round 1)", {
  timeout: 60_000,
}, () => {
  it("flags components of a builtin plugin and refuses their scope changes", async () => {
    const { itemId, skillId } = await crmInBoth();
    const list = async () =>
      (await env.root({ method: "GET", url: "/api/v1/admin/components?kind=skill" })).json()
        .components as { id: string; builtin: boolean }[];
    expect((await list()).find((c) => c.id === skillId)).toMatchObject({ builtin: false });
    await setBuiltin(env, itemId);
    expect((await list()).find((c) => c.id === skillId)).toMatchObject({ builtin: true });
    const pv = await env.root({
      method: "POST",
      url: `/api/v1/admin/components/skill/${skillId}/scope/preview`,
      payload: { disabled: true },
    });
    expect(pv.statusCode).toBe(409);
    expect(pv.json().error.code).toBe("plugin.builtin");
  });

  it("lists org-owned skills and agent templates read-only with their org and versions (ruling P2-11)", async () => {
    await crmInBoth();
    const org = await env.db
      .selectFrom("orgs")
      .select("name")
      .where("id", "=", env.orgId)
      .executeTakeFirstOrThrow();
    const skillId = "11111111-aaaa-4aaa-8aaa-111111111111";
    await env.db
      .insertInto("skills")
      .values({
        id: skillId,
        org_id: env.orgId,
        scope: "org",
        agent_id: null,
        name: "house-style",
        description: "Our style",
        current_version: 2,
        created_by: env.bossId,
      })
      .execute();
    for (const version of [1, 2]) {
      await env.db
        .insertInto("skill_versions")
        .values({
          skill_id: skillId,
          version,
          manifest: JSON.stringify({ name: "house-style", description: "Our style" }) as never,
          object_prefix: `kernel/${env.orgId}/skills/${skillId}/${version}/`,
          created_by: env.bossId,
        })
        .execute();
    }
    const tplId = "22222222-aaaa-4aaa-8aaa-222222222222";
    await env.db
      .insertInto("agent_templates")
      .values({ id: tplId, org_id: env.orgId, name: "helper", current_version: 1 })
      .execute();
    await env.db
      .insertInto("agent_template_versions")
      .values({ template_id: tplId, version: 1, definition: JSON.stringify({}) as never })
      .execute();

    const skills = (
      await env.root({ method: "GET", url: "/api/v1/admin/components?kind=skill" })
    ).json().components as Record<string, unknown>[];
    expect(skills.find((c) => c.name === "pdf-tools")).toMatchObject({
      owner: { kind: "platform" },
      promoted: false,
    });
    expect(skills.find((c) => c.id === skillId)).toMatchObject({
      kind: "skill",
      name: "house-style",
      owner: { kind: "org", orgId: env.orgId, name: org.name },
      shareable: false,
      promoted: false,
      plugin: null,
      version: "2",
      builtin: false,
      onIn: [env.orgId],
    });
    const tpls = (
      await env.root({ method: "GET", url: "/api/v1/admin/components?kind=agent_template" })
    ).json().components as Record<string, unknown>[];
    expect(tpls.find((c) => c.id === tplId)).toMatchObject({
      owner: { kind: "org", orgId: env.orgId },
      version: "1",
    });
    // connector templates are never org-owned
    const conns = (
      await env.root({ method: "GET", url: "/api/v1/admin/components?kind=connector_template" })
    ).json().components as { owner: { kind: string } }[];
    expect(conns.every((c) => c.owner.kind === "platform")).toBe(true);

    const v = await env.root({
      method: "GET",
      url: `/api/v1/admin/components/skill/${skillId}/versions`,
    });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().versions.map((x: { version: string }) => x.version)).toEqual(["2", "1"]);
    // read-only in the admin console: no scope, disable or upload
    const pv = await env.root({
      method: "POST",
      url: `/api/v1/admin/components/skill/${skillId}/scope/preview`,
      payload: { disabled: true },
    });
    expect(pv.statusCode).toBe(404);
  });
});

/**
 * Task 10: what the workspace pages read. The org's component list (offered platform components
 * with their state in the org, members included) and the detail of a linked copy.
 */
describe("the org component list and linked copies (Task 10)", { timeout: 60_000 }, () => {
  const list = (req: OrgEnv["boss"], query: string) =>
    req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/components?${query}` });

  it("lists offered components with their state; members read it; `all` is locked; a plugin that is off is not switchable", async () => {
    const { itemId, skillId } = await crmInBoth();
    const other = await seedPlugin(env, { name: "docs", skills: ["notes"], templates: false });
    const notes = (
      await env.db
        .selectFrom("platform_skills")
        .select("id")
        .where("name", "=", "notes")
        .executeTakeFirstOrThrow()
    ).id;
    const r = await list(env.mem, "kind=skill");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().components).toEqual([
      expect.objectContaining({
        id: notes,
        name: "notes",
        itemId: other,
        on: false,
        switchable: false,
        pluginOn: false,
      }),
      expect.objectContaining({
        kind: "skill",
        id: skillId,
        name: "pdf-tools",
        plugin: "crm",
        itemId,
        on: true,
        locked: false,
        switchable: true,
        pluginOn: true,
      }),
    ]);
    // by plugin, every kind
    const byItem = await list(env.mem, `itemId=${itemId}`);
    expect(byItem.statusCode, byItem.body).toBe(200);
    expect(byItem.json().components.map((c: { id: string }) => c.id)).toEqual([skillId]);
    // switched off in the org: still listed, off, switchable
    const p = await sw(env.orgId, env.boss, skillId, { enabled: false });
    await sw(env.orgId, env.boss, skillId, { enabled: false, confirm: p.json().confirm });
    const pdf = async () =>
      (await list(env.boss, "kind=skill"))
        .json()
        .components.find((c: { id: string }) => c.id === skillId);
    const off = await pdf();
    expect(off).toMatchObject({ id: skillId, on: false, switch: false, switchable: true });
    await sw(env.orgId, env.boss, skillId, { enabled: true });
    await setScope(env, itemId, "all");
    const locked = await pdf();
    expect(locked).toMatchObject({ id: skillId, on: true, locked: true, switchable: false });
    // a component not offered to the org is not listed
    await setScope(env, other, "named", [org2]);
    expect(
      (await list(env.boss, "kind=skill")).json().components.map((c: { id: string }) => c.id),
    ).toEqual([skillId]);
    // a bad kind is refused
    expect((await list(env.boss, "kind=nope")).statusCode).toBe(400);
  });

  it("an unpinned linked copy's detail is its platform skill's; a pinned copy keeps its own", async () => {
    const { skillId } = await crmInBoth();
    const copy = "00000000-0000-4000-8000-000000000010";
    await env.db
      .insertInto("skills")
      .values({
        id: copy,
        org_id: env.orgId,
        scope: "org",
        agent_id: null,
        name: "pdf-tools",
        description: "Copy.",
        current_version: 1,
        platform_skill_id: skillId,
      })
      .execute();
    await env.db
      .insertInto("skill_versions")
      .values({
        skill_id: copy,
        version: 1,
        manifest: JSON.stringify({ name: "pdf-tools", description: "Copy.", files: [] }),
        object_prefix: "skills/copy10/",
      })
      .execute();
    const get = () => env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/skills/${copy}` });
    const r = await get();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: skillId, origin: "platform" });
    expect(r.json().description).not.toBe("Copy.");
    await env.db.updateTable("skills").set({ pinned_version: 1 }).where("id", "=", copy).execute();
    expect((await get()).json()).toMatchObject({ id: copy, origin: "org", description: "Copy." });
    // the component list names unpinned copies only (the agent editor's unavailable ids)
    const listed = async () =>
      (
        await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/components?kind=skill` })
      ).json().components[0].linkedIds;
    expect(await listed()).toEqual([]);
    await env.db
      .updateTable("skills")
      .set({ pinned_version: null })
      .where("id", "=", copy)
      .execute();
    expect(await listed()).toEqual([copy]);
  });
});
