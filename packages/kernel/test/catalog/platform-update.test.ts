import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformComponents } from "../../src/catalog/platform-components.js";
import { PluginInstaller } from "../../src/catalog/plugin-install.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { currentStore } from "../../src/infra/database/transaction-host.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { skillVersionsById, usableSkills } from "../../src/skills/usable.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { ConnectorsService } from "../../src/tools/connectors.service.js";
import { lifePkg, pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, enableExtensions, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  importPlugin,
  install,
  legacyCopies,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setPolicy,
  startOrgEnv,
} from "./org-env.js";

/**
 * Plugin scope phase 2, Task 7: a platform plugin is updated once for the deployment (spec §7,
 * ruling F2). The preview lists every component (added / removed / upgrade / downgrade / same),
 * marks the ones updated on their own and the ones with their own scope, the orgs whose linked copy
 * is pinned, and the org connectors made from changed templates; the confirm writes the platform
 * versions, clears the pins, fans template changes out to every org's connectors and moves every
 * org install to the version, in one transaction (a failure leaves everything as it was).
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

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
  // org2 creates connectors of the fake-connector kind too
  await enableExtensions(env.db, org2, "fake-connector");
});

const tokenInput = () => ({ endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } });

const previewReq = (itemId: string, version: string, req = env.root) =>
  req({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
    payload: { version },
  });

async function previewOk(itemId: string, version: string): Promise<PlatformUpdatePreview> {
  const r = await previewReq(itemId, version);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as PlatformUpdatePreview;
}

const confirm = (itemId: string, body: Record<string, unknown>, req = env.root) =>
  req({ method: "PUT", url: `/api/v1/admin/catalog/items/${itemId}/update`, payload: body });

/** Previews and confirms an update to `version`; returns the preview. */
async function updateTo(itemId: string, version: string): Promise<PlatformUpdatePreview> {
  const p = await previewOk(itemId, version);
  const r = await confirm(itemId, { version, diffHash: p.diffHash });
  expect(r.statusCode, r.body).toBe(200);
  return p;
}

/** Installs the item in `orgId` (org1 through its admin, org2 through root). */
async function installIn(
  orgId: string,
  itemId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const r =
    orgId === env.orgId
      ? await install(env.boss, env, itemId, body)
      : await env.root({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/catalog/${itemId}/install`,
          payload: body,
        });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

const platformSkill = (name: string) =>
  env.db
    .selectFrom("platform_skills")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirstOrThrow();

/** An org agent of org1 selecting these skills (ids as in its definition). */
async function agentUsing(orgSkills: string[]): Promise<string> {
  const r = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Skilled",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
        skills: { orgSkills },
      },
      visibility: "org",
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json().agent?.id ?? r.json().id) as string;
}

/** The connector of `orgId` made from platform template `templateId` of the item. */
async function connectorFrom(orgId: string, templateId: string) {
  return env.db
    .selectFrom("connectors as c")
    .innerJoin("platform_connector_templates as t", "t.id", "c.platform_template_id")
    .select(["c.id", "c.name", "c.auth", "c.catalog_version", "c.updated_at"])
    .where("c.org_id", "=", orgId)
    .where("t.template_id", "=", templateId)
    .where("c.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
}

const toolPolicies = async (connectorId: string) =>
  Object.fromEntries(
    (
      await env.db
        .selectFrom("connector_tools")
        .select(["name", "default_policy", "policy_source"])
        .where("connector_id", "=", connectorId)
        .execute()
    ).map((t) => [t.name, `${t.default_policy}:${t.policy_source}`]),
  );

const secretsOf = async (connectorId: string) =>
  (
    await env.db
      .selectFrom("secrets")
      .select(["key", "ciphertext"])
      .where("key", "like", `%${connectorId}%`)
      .orderBy("key")
      .execute()
  ).map((s) => `${s.key}:${s.ciphertext.toString("hex")}`);

/** Everything an update writes, for "nothing changed" comparisons. */
async function snapshot() {
  const [skills, skillVersions, templates, copies, connectors, tools, secrets, installs, item] =
    await Promise.all([
      env.db
        .selectFrom("platform_skills")
        .select(["id", "name", "current_version", "deleted_at", "scope_mode"])
        .orderBy("name")
        .execute(),
      env.db
        .selectFrom("platform_skill_versions")
        .select(["skill_id", "version", "catalog_version", "updated_on_own", "suggest_pinned"])
        .orderBy("skill_id")
        .orderBy("version")
        .execute(),
      env.db
        .selectFrom("platform_connector_templates")
        .select(["id", "template_id", "current_version", "file", "deleted_at"])
        .orderBy("template_id")
        .execute(),
      env.db
        .selectFrom("skills")
        .select(["id", "platform_skill_id", "pinned_version", "deleted_at"])
        .orderBy("id")
        .execute(),
      env.db
        .selectFrom("connectors")
        .select(["id", "endpoint", "auth", "catalog_version", "template_tool_policies"])
        .orderBy("id")
        .execute(),
      env.db
        .selectFrom("connector_tools")
        .select(["connector_id", "name", "default_policy", "policy_source"])
        .orderBy("connector_id")
        .orderBy("name")
        .execute(),
      env.db.selectFrom("secrets").select(["key", "ciphertext"]).orderBy("key").execute(),
      env.db
        .selectFrom("plugin_installs")
        .select(["id", "version", "status"])
        .orderBy("id")
        .execute(),
      env.db.selectFrom("catalog_items").select(["id", "platform_synced_version"]).execute(),
    ]);
  return { skills, skillVersions, templates, copies, connectors, tools, secrets, installs, item };
}

/**
 * crm 1.0.0: skills keep / change / tweak / drop, template gh (search allow, delete_all allow);
 * 2.0.0: keep (same), change and tweak (new scripts), add; gh (search ask), docs added.
 */
async function seedCrm(): Promise<string> {
  const item = await seedPlugin(env, {
    name: "crm",
    skills: ["keep", "change", "tweak", "drop"],
    templates: { gh: { defaultToolPolicies: { search: "allow", delete_all: "allow" } } },
  });
  await seedPlugin(env, {
    name: "crm",
    addTo: item,
    version: "2.0.0",
    skills: ["keep", "change", "tweak", "add"],
    skillScripts: { change: "print(2)\n", tweak: "print(3)\n" },
    templates: { gh: { defaultToolPolicies: { search: "ask", delete_all: "allow" } }, docs: {} },
  });
  return item;
}

describe("platform plugin update (spec §7)", { timeout: 120_000 }, () => {
  it("preview marks a component updated on its own and one with its own scope; confirm moves both, clears a pinned copy, updates connectors in two orgs", async () => {
    const item = await seedCrm();
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    await installIn(org2, item, { connectors: { gh: tokenInput() } });
    const change = await platformSkill("change");
    const tweak = await platformSkill("tweak");
    const drop = await platformSkill("drop");
    // change was updated on its own (ruling P2-1: the flag seeded directly)
    await env.db
      .updateTable("platform_skill_versions")
      .set({ updated_on_own: true })
      .where("skill_id", "=", change.id)
      .execute();
    // tweak has its own scope (on everywhere)
    await env.db
      .updateTable("platform_skills")
      .set({ scope_mode: "own", scope: "all" })
      .where("id", "=", tweak.id)
      .execute();
    // org1 holds a copy of change linked to it and pinned to its own version (ruling B2)
    await legacyCopies(env, env.orgId, item, env.bossId);
    const copy = await env.db
      .selectFrom("skills")
      .select(["id", "current_version"])
      .where("org_id", "=", env.orgId)
      .where("name", "=", "change")
      .executeTakeFirstOrThrow();
    await env.db
      .deleteFrom("skills")
      .where("org_id", "=", env.orgId)
      .where("name", "<>", "change")
      .execute();
    await env.db
      .updateTable("skills")
      .set({ platform_skill_id: change.id, pinned_version: copy.current_version })
      .where("id", "=", copy.id)
      .execute();
    // an agent of org1 uses drop: it stays when 2.0.0 leaves it out (spec §7.3)
    const agent = await agentUsing([drop.id]);
    const gh1 = await connectorFrom(env.orgId, "gh");
    const gh2 = await connectorFrom(org2, "gh");
    const secrets1 = await secretsOf(gh1.id);
    expect(secrets1).toHaveLength(1);

    const p = await previewOk(item, "2.0.0");
    expect(p).toMatchObject({ itemId: item, name: "crm", from: "1.0.0", to: "2.0.0" });
    expect(p.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.extension).toBeNull();
    const base = { updatedOnOwn: false, ownScope: false, pinnedOrgs: [] };
    expect(p.components).toEqual([
      { kind: "skill", id: null, name: "add", change: "added", from: null, to: "2.0.0", ...base },
      {
        kind: "skill",
        id: change.id,
        name: "change",
        change: "upgrade",
        from: "1.0.0",
        to: "2.0.0",
        ...base,
        updatedOnOwn: true,
        pinnedOrgs: [env.orgId],
      },
      {
        kind: "skill",
        id: drop.id,
        name: "drop",
        change: "removed",
        from: "1.0.0",
        to: null,
        ...base,
        kept: [{ orgId: env.orgId, agents: [{ id: agent, name: "Skilled" }] }],
      },
      {
        kind: "skill",
        id: (await platformSkill("keep")).id,
        name: "keep",
        change: "same",
        from: "1.0.0",
        to: "2.0.0",
        ...base,
      },
      {
        kind: "skill",
        id: tweak.id,
        name: "tweak",
        change: "upgrade",
        from: "1.0.0",
        to: "2.0.0",
        ...base,
        ownScope: true,
      },
      {
        kind: "connector_template",
        id: null,
        name: "docs",
        change: "added",
        from: null,
        to: "2.0.0",
        ...base,
      },
      {
        kind: "connector_template",
        id: expect.any(String),
        name: "gh",
        change: "upgrade",
        from: "1.0.0",
        to: "2.0.0",
        ...base,
      },
    ]);
    const orgs = [env.orgId, org2].sort();
    const conn = (orgId: string) => ({
      orgId,
      connectors: [
        {
          id: orgId === env.orgId ? gh1.id : gh2.id,
          name: orgId === env.orgId ? gh1.name : gh2.name,
          templateId: "gh",
          credentialsReset: false,
        },
      ],
      // the added template is on in both orgs; its connector needs the org's input
      needsConfig: ["docs"],
    });
    expect(p.connectorOrgs).toEqual(orgs.map(conn));

    const r = await confirm(item, { version: "2.0.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(200);

    // both moved: a new platform version each, the own scope kept
    const changeNow = await platformSkill("change");
    expect(changeNow.current_version).toBe(2);
    const v2 = await env.db
      .selectFrom("platform_skill_versions")
      .select(["catalog_version", "updated_on_own"])
      .where("skill_id", "=", change.id)
      .where("version", "=", 2)
      .executeTakeFirstOrThrow();
    expect(v2).toEqual({ catalog_version: "2.0.0", updated_on_own: false });
    expect(await platformSkill("tweak")).toMatchObject({ current_version: 2, scope_mode: "own" });
    expect((await platformSkill("keep")).current_version).toBe(1);
    // drop stays for the agent using it
    expect((await platformSkill("drop")).deleted_at).toBeNull();
    // the pin is cleared: the copy resolves to the platform skill's new version under its own id
    const copyNow = await env.db
      .selectFrom("skills")
      .select("pinned_version")
      .where("id", "=", copy.id)
      .executeTakeFirstOrThrow();
    expect(copyNow.pinned_version).toBeNull();
    const resolved = await skillVersionsById(env.db, env.orgId, [copy.id]);
    expect(resolved.get(copy.id)).toMatchObject({ id: copy.id, version: 2, origin: "platform" });
    // the added skill is usable in both orgs
    for (const orgId of [env.orgId, org2]) {
      expect((await usableSkills(env.db, orgId)).map((s) => s.name)).toContain("add");
    }
    // the gh connector of both orgs follows the template, credentials kept
    for (const c of [gh1, gh2]) {
      const now = await env.db
        .selectFrom("connectors")
        .select(["catalog_version"])
        .where("id", "=", c.id)
        .executeTakeFirstOrThrow();
      expect(now.catalog_version).toBe("2.0.0");
      expect((await toolPolicies(c.id)).search).toBe("ask:template");
    }
    expect(await secretsOf(gh1.id)).toEqual(secrets1);
    // every org install is at the version; the platform records it
    const installs = await env.db
      .selectFrom("plugin_installs")
      .select(["org_id", "version"])
      .where("item_id", "=", item)
      .execute();
    expect(installs.map((i) => i.version)).toEqual(["2.0.0", "2.0.0"]);
    const row = await env.db
      .selectFrom("catalog_items")
      .select("platform_synced_version")
      .where("id", "=", item)
      .executeTakeFirstOrThrow();
    expect(row.platform_synced_version).toBe("2.0.0");
    expect(await auditActions(env)).toContain("plugin.platform_updated");

    // nothing left to update
    const again = await previewReq(item, "2.0.0");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("plugin.upgrade_target_invalid");
  });

  it("a removed component no agent uses is removed: its linked copies go with it, a pinned copy keeps its own version", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["a", "b"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["a"],
      templates: false,
    });
    await installIn(env.orgId, item);
    await installIn(org2, item);
    const b = await platformSkill("b");
    // org1: a linked copy (unpinned); org2: a pinned copy
    for (const orgId of [env.orgId, org2]) {
      await legacyCopies(env, orgId, item, env.rootId);
      await env.db
        .updateTable("skills")
        .set({ platform_skill_id: b.id, pinned_version: orgId === org2 ? 1 : null })
        .where("org_id", "=", orgId)
        .where("name", "=", "b")
        .execute();
      await env.db
        .deleteFrom("skills")
        .where("org_id", "=", orgId)
        .where("name", "=", "a")
        .execute();
    }
    const p = await updateTo(item, "1.1.0");
    expect(p.components.find((c) => c.name === "b")).toMatchObject({
      change: "removed",
      pinnedOrgs: [org2],
    });
    expect(p.components.find((c) => c.name === "b")?.kept).toBeUndefined();
    expect((await platformSkill("b")).deleted_at).not.toBeNull();
    expect((await usableSkills(env.db, env.orgId)).map((s) => s.name)).toEqual(["a"]);
    expect((await usableSkills(env.db, org2)).map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("a changed template whose auth needs other credentials: the orgs' credentials are cleared and the preview says so", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [], templates: { gh: {} } });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "1.1.0",
      skills: [],
      templates: { gh: { auth: { type: "headers", ownership: "org", names: ["X-Key"] } } },
    });
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    const gh = await connectorFrom(env.orgId, "gh");
    expect(await secretsOf(gh.id)).toHaveLength(1);
    const p = await updateTo(item, "1.1.0");
    expect(p.connectorOrgs).toEqual([
      {
        orgId: env.orgId,
        connectors: [{ id: gh.id, name: gh.name, templateId: "gh", credentialsReset: true }],
        needsConfig: [],
      },
    ]);
    const now = await connectorFrom(env.orgId, "gh");
    expect(now.auth).toEqual({ type: "headers", ownership: "org", names: ["X-Key"] });
    expect(await secretsOf(gh.id)).toEqual([]);
  });

  it("default tool policies follow the template unless the org set them; a downgrade restores them", async () => {
    const item = await seedPlugin(env, {
      name: "crm",
      skills: [],
      templates: { gh: { defaultToolPolicies: { search: "deny", delete_all: "allow" } } },
    });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "1.1.0",
      skills: [],
      templates: { gh: { defaultToolPolicies: { search: "deny" } } },
    });
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    const gh = await connectorFrom(env.orgId, "gh");
    await updateTo(item, "1.1.0");
    const derived = await toolPolicies(gh.id);
    expect(derived.search).toBe("deny:template");
    expect(derived.delete_all).toMatch(/:derived$/);
    const back = await updateTo(item, "1.0.0");
    expect(back.components).toEqual([
      expect.objectContaining({ kind: "connector_template", name: "gh", change: "downgrade" }),
    ]);
    expect(await toolPolicies(gh.id)).toEqual({
      search: "deny:template",
      delete_all: "allow:template",
    });
  });

  it("a failure midway (the second org's connector) undoes everything", async () => {
    const item = await seedCrm();
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    await installIn(org2, item, { connectors: { gh: tokenInput() } });
    const change = await platformSkill("change");
    await legacyCopies(env, env.orgId, item, env.bossId);
    await env.db
      .updateTable("skills")
      .set({ platform_skill_id: change.id, pinned_version: 1 })
      .where("org_id", "=", env.orgId)
      .where("name", "=", "change")
      .execute();
    const p = await previewOk(item, "2.0.0");
    const before = await snapshot();
    const real = ConnectorsService.prototype.applyTemplateIn;
    let calls = 0;
    vi.spyOn(ConnectorsService.prototype, "applyTemplateIn").mockImplementation(async function (
      this: ConnectorsService,
      ...args: Parameters<ConnectorsService["applyTemplateIn"]>
    ) {
      await real.apply(this, args);
      calls += 1;
      if (calls === 2) throw new Error("injected connector failure");
    });
    const r = await confirm(item, { version: "2.0.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.code).toBe("plugin.upgrade_failed");
    expect(r.json().error.details[0]).toMatchObject({ code: "internal", rolledBack: true });
    expect(calls).toBe(2);
    expect(await snapshot()).toEqual(before);
    expect(await auditActions(env)).toContain("plugin.platform_update_failed");
    // and it can be updated afterwards
    vi.restoreAllMocks();
    await updateTo(item, "2.0.0");
  });

  it("the item detail names the platform's version, which an imported newer version does not move", async () => {
    const item = await seedPlugin(env, { name: "memo", skills: ["memo"], templates: false });
    await seedPlugin(env, {
      name: "memo",
      addTo: item,
      version: "1.1.0",
      skills: ["memo"],
      templates: false,
    });
    const read = async () => {
      const r = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${item}` });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().item as { versions: string[]; platformVersion: string };
    };
    expect(await read()).toMatchObject({ versions: ["1.1.0", "1.0.0"], platformVersion: "1.0.0" });
    await updateTo(item, "1.1.0");
    expect(await read()).toMatchObject({ platformVersion: "1.1.0" });
  });

  it("a stale diffHash is 409 plugin.upgrade_stale and nothing changes", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "more"],
      templates: false,
    });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.2.0",
      skills: ["notes", "most"],
      templates: false,
    });
    const p = await previewOk(item, "1.1.0");
    const before = await snapshot();
    const fake = await confirm(item, { version: "1.1.0", diffHash: "0".repeat(64) });
    expect(fake.statusCode).toBe(409);
    expect(fake.json().error.code).toBe("plugin.upgrade_stale");
    const other = await confirm(item, { version: "1.2.0", diffHash: p.diffHash });
    expect(other.json().error.code).toBe("plugin.upgrade_stale");
    // a pin set since the preview changes what the confirm would do
    await installIn(env.orgId, item);
    await legacyCopies(env, env.orgId, item, env.bossId);
    await env.db
      .updateTable("skills")
      .set({ platform_skill_id: (await platformSkill("notes")).id, pinned_version: 1 })
      .where("org_id", "=", env.orgId)
      .execute();
    const pinned = await confirm(item, { version: "1.1.0", diffHash: p.diffHash });
    expect(pinned.json().error.code).toBe("plugin.upgrade_stale");
    const after = await snapshot();
    expect(after.skills).toEqual(before.skills);
    expect(after.skillVersions).toEqual(before.skillVersions);
    expect(after.item).toEqual(before.item);
  });

  it("only super admins; a disabled item is refused; the org upgrade routes are gone (ruling F2)", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "more"],
      templates: false,
    });
    const installId = await installIn(env.orgId, item);
    expect((await previewReq(item, "1.1.0", env.boss)).statusCode).toBe(403);
    const p = await previewOk(item, "1.1.0");
    expect(
      (await confirm(item, { version: "1.1.0", diffHash: p.diffHash }, env.boss)).statusCode,
    ).toBe(403);
    await setPolicy(env, item, "disabled");
    const off = await previewReq(item, "1.1.0");
    expect(off.json().error.code).toBe("catalog.item_disabled");
    await setPolicy(env, item, "allow");
    const org = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade/preview`,
      payload: { version: "1.1.0" },
    });
    expect(org.statusCode).toBe(404);
    // the org view offers no per-org upgrade
    const list = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs`,
    });
    expect(list.json().installs[0]).toMatchObject({
      upgradeAvailable: null,
      deploymentPending: false,
    });
  });

  it("an added skill whose name an org already uses where the plugin is on: 409 plugin.skill_conflict (rule 10)", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "journal"],
      templates: false,
    });
    await installIn(env.orgId, item);
    const md = new TextEncoder().encode(SKILL_MD("journal"));
    const own = await env.k.app.get(SkillsService).createVersionFromFiles(env.orgId, env.bossId, {
      name: "journal",
      description: "Mine.",
      files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
    });
    const r = await previewReq(item, "1.1.0");
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("plugin.skill_conflict");
    expect(r.json().error.details).toEqual([
      { skill: "journal", orgId: env.orgId, conflicts: [own.skill.id] },
    ]);
  });

  it("a plugin another plugin depends on cannot move outside that dependency's range", async () => {
    const lib = await seedPlugin(env, { name: "lib", skills: ["lib"], templates: false });
    await seedPlugin(env, {
      name: "lib",
      addTo: lib,
      version: "2.0.0",
      skills: ["lib"],
      templates: false,
      skillScripts: { lib: "x\n" },
    });
    await seedPlugin(env, {
      name: "app",
      skills: ["app"],
      templates: false,
      dependencies: [{ name: "lib", version: "^1.0.0" }],
    });
    const r = await previewReq(lib, "2.0.0");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("plugin.upgrade_target_invalid");
    expect(r.json().error.details).toEqual([
      { reason: "dependent_range", dependent: "app", range: "^1.0.0", version: "2.0.0" },
    ]);
  });
});

describe("platform plugin update: concurrency and the extension", { timeout: 120_000 }, () => {
  it("two confirms at once: one updates, the other gets 409, no half state", async () => {
    const item = await seedCrm();
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    const p = await previewOk(item, "2.0.0");
    const body = { version: "2.0.0", diffHash: p.diffHash };
    const [a, b] = await Promise.all([confirm(item, body), confirm(item, body)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(["plugin.install_in_progress", "plugin.upgrade_stale"]).toContain(
      loser.json().error.code,
    );
    expect((await platformSkill("change")).current_version).toBe(2);
    const versions = await env.db
      .selectFrom("platform_skill_versions")
      .select("version")
      .where("skill_id", "=", (await platformSkill("change")).id)
      .execute();
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it("an extension declared in the startup config cannot be moved by an update", async () => {
    const item = await seedPlugin(env, {
      name: "fake-tools-ui",
      extension: true,
      version: "0.1.0",
      skills: [],
      templates: false,
    });
    await seedPlugin(env, {
      name: "fake-tools-ui",
      addTo: item,
      extension: true,
      version: "0.2.0",
      skills: [],
      templates: false,
    });
    const r = await previewReq(item, "0.2.0");
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("plugin.upgrade_target_invalid");
    expect(r.json().error.details).toEqual([
      { reason: "config_extension", deploymentVersion: "0.1.0" },
    ]);
  });
});

describe("uninstall and dependencies (Task 7 carry-over)", { timeout: 120_000 }, () => {
  it("the uninstall preview lists agents using components of the dependency installs it removes", async () => {
    await seedPlugin(env, { name: "dep-a", skills: ["dep-skill"], templates: false });
    const app = await seedPlugin(env, {
      name: "app",
      skills: ["app-skill"],
      templates: false,
      dependencies: [{ name: "dep-a", version: "^1.0.0" }],
    });
    const installId = await installIn(env.orgId, app);
    const dep = await platformSkill("dep-skill");
    const agent = await agentUsing([dep.id]);
    const p = await env.k.app.get(PluginInstaller).previewUninstall(env.orgId, installId);
    expect(p.agents).toEqual([
      { id: agent, name: "Skilled", uses: [{ kind: "skill", ref: dep.id }] },
    ]);
  });
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const extensionRow = (name: string) =>
  env.db
    .selectFrom("extension_installs")
    .select(["sha256", "version", "desired_state"])
    .where("name", "=", name)
    .executeTakeFirst();
const syncedVersion = async (itemId: string) =>
  (
    await env.db
      .selectFrom("catalog_items")
      .select("platform_synced_version")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow()
  ).platform_synced_version;
const loaded = (name: string) => env.k.app.get(ExtensionHost).current(name)?.manifest.version;

describe("platform plugin update: the extension (fix round 1)", { timeout: 180_000 }, () => {
  it("moves the deployment's extension package; the preview lists the orgs using it; a crash after the extension step is completed by a new preview", async () => {
    const v1 = await lifePkg({ name: "upd-move", version: "1.0.0" });
    const v2 = await lifePkg({ name: "upd-move", version: "2.0.0" });
    const item = await importPlugin(env, v1);
    await waitFor(async () => loaded("upd-move") === "1.0.0", 15_000, "1.0.0 loaded");
    await installIn(env.orgId, item);
    // importing 2.0.0 deploys its extension; the platform stays at 1.0.0
    await importPlugin(env, v2);
    expect(await extensionRow("upd-move")).toMatchObject({ sha256: sha(v2), version: "2.0.0" });
    const up = await updateTo(item, "2.0.0");
    expect(up.extension).toBeNull();
    // back to 1.0.0: the update moves the package
    const p = await previewOk(item, "1.0.0");
    expect(p.extension).toEqual({
      from: "2.0.0",
      to: "1.0.0",
      orgs: [env.orgId],
      needsApproval: false,
    });
    const r = await confirm(item, { version: "1.0.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().extension).toMatchObject({ from: "2.0.0", to: "1.0.0" });
    expect(await extensionRow("upd-move")).toMatchObject({ sha256: sha(v1), version: "1.0.0" });
    expect(await syncedVersion(item)).toBe("1.0.0");
    await waitFor(async () => loaded("upd-move") === "1.0.0", 15_000, "1.0.0 loaded");
    // a crash between the extension step and the transaction: the extension moved alone
    const moved = await env.root({
      method: "POST",
      url: "/api/v1/admin/extensions/upd-move/install",
      payload: { sha256: sha(v2) },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const again = await previewOk(item, "2.0.0");
    expect(again.extension).toBeNull();
    const done = await confirm(item, { version: "2.0.0", diffHash: again.diffHash });
    expect(done.statusCode, done.body).toBe(200);
    expect(await syncedVersion(item)).toBe("2.0.0");
  });

  it("adds an extension the deployment does not run (installed and enabled; approval flagged); a failure afterwards disables and uninstalls it again", async () => {
    const d1 = await pluginTgz({
      manifest: { name: "upd-add", version: "1.0.0", skills: [{ path: "./skills/notes" }] },
      files: { "skills/notes/SKILL.md": SKILL_MD("notes") },
    });
    const d2 = await lifePkg({ name: "upd-add", version: "2.0.0" });
    const item = await importPlugin(env, d1);
    await importPlugin(env, d2);
    // the deployment no longer runs it, and no approval covers it
    for (const [method, url] of [
      ["POST", "/api/v1/admin/extensions/upd-add/disable"],
      ["DELETE", "/api/v1/admin/extensions/upd-add"],
    ] as const) {
      const r = await env.root({ method, url });
      expect(r.statusCode, r.body).toBeLessThan(300);
    }
    await env.db
      .deleteFrom("extension_permission_snapshots")
      .where("plugin", "=", "upd-add")
      .execute();
    expect(await extensionRow("upd-add")).toBeUndefined();
    // This replica may still run the uninstalled extension until its reconcile catches up (the
    // flake this pins down): a loaded extension without an install record is not config-declared
    const realManifests = ExtensionRegistry.prototype.manifests;
    const stillLoaded = vi
      .spyOn(ExtensionRegistry.prototype, "manifests")
      .mockImplementation(function (this: ExtensionRegistry) {
        const ms = realManifests.call(this);
        return ms.some((m) => m.name === "upd-add")
          ? ms
          : [...ms, { name: "upd-add", version: "2.0.0" } as (typeof ms)[number]];
      });
    // without extensionPermissions.autoApprove (the test kernels turn it on) it waits for approval
    const realGet = KernelConfigService.prototype.get;
    const noAuto = vi.spyOn(KernelConfigService.prototype, "get").mockImplementation(function (
      this: KernelConfigService,
    ) {
      const c = realGet.call(this);
      return { ...c, extensionPermissions: { ...c.extensionPermissions, autoApprove: false } };
    });
    const p = await previewOk(item, "2.0.0");
    expect(p.extension).toEqual({ from: null, to: "2.0.0", orgs: [], needsApproval: true });
    noAuto.mockRestore();
    expect((await previewOk(item, "2.0.0")).extension?.needsApproval).toBe(false);
    stillLoaded.mockRestore();
    vi.spyOn(PlatformComponents.prototype, "applySyncIn").mockRejectedValueOnce(
      new Error("injected sync failure"),
    );
    const failed = await confirm(item, { version: "2.0.0", diffHash: p.diffHash });
    expect(failed.statusCode, failed.body).toBe(502);
    expect(failed.json().error.details[0]).toMatchObject({ step: "components", rolledBack: true });
    expect(await extensionRow("upd-add")).toBeUndefined();
    expect(await syncedVersion(item)).toBe("1.0.0");
    vi.restoreAllMocks();
    const ok = await confirm(item, { version: "2.0.0", diffHash: p.diffHash });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await extensionRow("upd-add")).toMatchObject({
      sha256: sha(d2),
      desired_state: "enabled",
    });
  });

  it("a downgrade the extension's migrations refuse is 409 extension.downgrade_unsupported and changes nothing", async () => {
    const notes = { file: "0001_notes.sql", sql: "CREATE TABLE IF NOT EXISTS notes (id int);\n" };
    const v1 = await lifePkg({ name: "upd-down", version: "1.0.0", migrations: [notes] });
    const v2 = await lifePkg({ name: "upd-down", version: "2.0.0", migrations: [notes] });
    const item = await importPlugin(env, v1);
    await importPlugin(env, v2);
    await waitFor(async () => loaded("upd-down") === "2.0.0", 15_000, "2.0.0 loaded");
    await updateTo(item, "2.0.0");
    // 1.0.0's migration counts as never run here
    await sql`DELETE FROM plugin_upd_down._migrations`.execute(env.db);
    const p = await previewOk(item, "1.0.0");
    expect(p.extension).toMatchObject({ from: "2.0.0", to: "1.0.0" });
    const r = await confirm(item, { version: "1.0.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("extension.downgrade_unsupported");
    expect(await extensionRow("upd-down")).toMatchObject({ sha256: sha(v2) });
    expect(await syncedVersion(item)).toBe("2.0.0");
  });
});

describe("platform plugin update: storage, dependencies, missing connectors (fix round 1)", {
  timeout: 180_000,
}, () => {
  it("no storage call runs inside the update's transaction", async () => {
    const item = await seedCrm();
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    const real = StorageService.prototype.deployment;
    let calls = 0;
    vi.spyOn(StorageService.prototype, "deployment").mockImplementation(function (
      this: StorageService,
    ) {
      calls += 1;
      if (currentStore()) throw new Error("storage called inside a transaction");
      return real.call(this);
    });
    await updateTo(item, "2.0.0");
    expect(calls).toBeGreaterThan(0);
    expect((await platformSkill("change")).current_version).toBe(2);
  });

  it("a target that adds a dependency: the scope sync installs it where the plugin is on (rule 9)", async () => {
    const dep = await seedPlugin(env, { name: "dep-a", skills: ["dep-skill"], templates: false });
    const app = await seedPlugin(env, { name: "app", skills: ["app-skill"], templates: false });
    await seedPlugin(env, {
      name: "app",
      addTo: app,
      version: "2.0.0",
      skills: ["app-skill"],
      templates: false,
      dependencies: [{ name: "dep-a", version: "^1.0.0" }],
    });
    const installId = await installIn(env.orgId, app);
    await updateTo(app, "2.0.0");
    const depInstall = await waitFor(
      async () =>
        env.db
          .selectFrom("plugin_installs")
          .select(["id", "status"])
          .where("org_id", "=", env.orgId)
          .where("item_id", "=", dep)
          .where("status", "=", "installed")
          .executeTakeFirst(),
      20_000,
      "dep-a installed by the scope sync",
    );
    const ledger = await env.db
      .selectFrom("plugin_install_components")
      .select(["kind", "ref", "created"])
      .where("install_id", "=", installId)
      .where("kind", "=", "plugin")
      .execute();
    expect(ledger).toEqual([{ kind: "plugin", ref: depInstall.id, created: true }]);
    expect((await usableSkills(env.db, env.orgId)).map((s) => s.name)).toContain("dep-skill");
  });

  it("an added connector template makes the installed plugin needs_config; the org admin creates the connector (P2-10)", async () => {
    const item = await seedCrm();
    await installIn(env.orgId, item, { connectors: { gh: tokenInput() } });
    const state = async () =>
      (
        (await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` })).json()
          .items as { id: string; state: string }[]
      ).find((i) => i.id === item)?.state;
    expect(await state()).toBe("on");
    await updateTo(item, "2.0.0");
    expect(await state()).toBe("needs_config");
    // the detail names the templates that miss a connector, for the 补充配置 wizard (Task 10)
    const missing = async () =>
      (await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog/${item}` })).json()
        .missingTemplates as { id: string }[];
    expect((await missing()).map((t) => t.id)).toEqual(["docs"]);
    const url = `/api/v1/orgs/${env.orgId}/catalog/${item}/connectors`;
    const member = await env.mem({
      method: "POST",
      url,
      payload: { inputs: { connectors: { docs: tokenInput() } } },
    });
    expect(member.statusCode).toBe(403);
    const notMissing = await env.boss({
      method: "POST",
      url,
      payload: { inputs: { connectors: { gh: tokenInput() } } },
    });
    expect(notMissing.statusCode).toBe(400);
    expect(notMissing.json().error.details[0].path).toBe("connectors.gh");
    const noCredential = await env.boss({
      method: "POST",
      url,
      payload: { inputs: { connectors: { docs: { endpoint: { url: env.mcp.url } } } } },
    });
    expect(noCredential.statusCode).toBe(400);
    const r = await env.boss({
      method: "POST",
      url,
      payload: { inputs: { connectors: { docs: tokenInput() } } },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().connectors).toEqual([{ templateId: "docs", connectorId: expect.any(String) }]);
    const docs = await connectorFrom(env.orgId, "docs");
    expect(docs.id).toBe(r.json().connectors[0].connectorId);
    const recorded = await env.db
      .selectFrom("plugin_install_components")
      .select(["ref", "template_id", "created"])
      .where("kind", "=", "connector")
      .where("template_id", "=", "docs")
      .execute();
    expect(recorded).toEqual([{ ref: docs.id, template_id: "docs", created: true }]);
    expect(await state()).toBe("on");
    expect(await missing()).toEqual([]);
  });
});
