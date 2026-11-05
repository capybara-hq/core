import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usableTemplates } from "../../src/agents/templates.js";
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
      { orgId: env.orgId, orgName: expect.any(String), agents: [{ id: agentId, name: "Skilled" }] },
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
        owner: "platform",
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
      { orgId: org2, orgName: "Beta", name: "pdf-tools", skills: [expect.any(String)] },
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
