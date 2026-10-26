import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginInstaller } from "../../src/catalog/plugin-install.js";
import type { UpgradePreview } from "../../src/catalog/plugin-upgrade.js";
import { ConnectorsService } from "../../src/tools/connectors.service.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  importDeployedPlugin,
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  setPolicy,
  startOrgEnv,
} from "./org-env.js";

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
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
});

const tokenInput = (token = MCP_TOKEN) => ({
  endpoint: { url: env.mcp.url },
  credential: { token },
});

const preview = (installId: string, version: string) =>
  env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade/preview`,
    payload: { version },
  });

async function previewOk(installId: string, version: string): Promise<UpgradePreview> {
  const r = await preview(installId, version);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as UpgradePreview;
}

const upgrade = (installId: string, body: Record<string, unknown>) =>
  env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade`,
    payload: body,
  });

const uninstall = (installId: string) =>
  env.boss({ method: "DELETE", url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}` });

async function installOk(itemId: string, body: Record<string, unknown> = {}): Promise<string> {
  const r = await install(env.boss, env, itemId, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().installed.pluginInstallId as string;
}

interface View {
  id: string;
  version: string;
  status: string;
  error: unknown;
  upgradeAvailable: string | null;
  deploymentPending: boolean;
}

async function viewOf(installId: string): Promise<View> {
  const r = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/plugin-installs` });
  const v = (r.json().installs as View[]).find((x) => x.id === installId);
  if (!v) throw new Error(`no install ${installId}`);
  return v;
}

const liveInstalls = async () =>
  (
    await env.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select(["i.name", "a.version", "a.status"])
      .orderBy("i.name")
      .execute()
  ).map((r) => `${r.name}@${r.version}:${r.status}`);

const skillRows = () =>
  env.db
    .selectFrom("skills")
    .select(["id", "name", "current_version", "catalog_version", "deleted_at"])
    .orderBy("name")
    .execute();

/** An org agent that selects these org skills. */
async function useSkills(orgSkills: string[]): Promise<string> {
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
  return r.json().agent?.id ?? r.json().id;
}

/** The connector an install created from template `templateId`. */
async function connectorOf(installId: string, templateId: string) {
  const c = await env.db
    .selectFrom("plugin_install_components")
    .select("ref")
    .where("install_id", "=", installId)
    .where("kind", "=", "connector")
    .where("template_id", "=", templateId)
    .executeTakeFirstOrThrow();
  return env.db
    .selectFrom("connectors")
    .select(["id", "endpoint", "auth", "catalog_version", "template_tool_policies", "deleted_at"])
    .where("id", "=", c.ref)
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

/** Everything an upgrade may touch, for "back exactly as before" comparisons. */
async function snapshot() {
  const skillsLive = await env.db
    .selectFrom("skills")
    .select(["id", "name", "current_version", "catalog_item_id", "catalog_version", "description"])
    .where("deleted_at", "is", null)
    .orderBy("id")
    .execute();
  const [skills, versions, installs, components, connectors, tools, secrets, enabled] =
    await Promise.all([
      Promise.resolve(skillsLive),
      env.db
        .selectFrom("skill_versions")
        .select(["skill_id", "version", "catalog_version"])
        .where(
          "skill_id",
          "in",
          skillsLive.length > 0
            ? skillsLive.map((x) => x.id)
            : ["00000000-0000-4000-8000-000000000000"],
        )
        .orderBy("skill_id")
        .orderBy("version")
        .execute(),
      env.db
        .selectFrom("plugin_installs")
        .select(["id", "item_id", "version", "status", "upgrade"])
        .orderBy("id")
        .execute(),
      env.db
        .selectFrom("plugin_install_components")
        .selectAll()
        .orderBy("install_id")
        .orderBy("kind")
        .orderBy("ref")
        .execute(),
      env.db
        .selectFrom("connectors")
        .select([
          "id",
          "endpoint",
          "auth",
          "catalog_version",
          "template_tool_policies",
          "deleted_at",
          "updated_at",
        ])
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
        .selectFrom("extension_org_configs")
        .select(["plugin", "enabled"])
        .where("org_id", "=", env.orgId)
        .orderBy("plugin")
        .execute(),
    ]);
  return { skills, versions, installs, components, connectors, tools, secrets, enabled };
}

/** Moves a running upgrade's start back a day (past catalog.staleInstallMinutes). */
const backdateUpgrade = (installId: string) =>
  sql`UPDATE capybara.plugin_installs
    SET upgrade = jsonb_set(upgrade, '{startedAt}', to_jsonb((now() - interval '1 day')::text))
    WHERE id = ${installId}`.execute(env.db);

/** An org's own skill (no provenance). */
const ownSkill = (name: string) => {
  const md = new TextEncoder().encode(SKILL_MD(name));
  return env.k.skills.createVersionFromFiles(env.orgId, env.bossId, {
    name,
    description: "Mine.",
    files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
  });
};

/**
 * crm 1.0.0 (skills keep / change / drop, templates gh / old, dependency dep-a) and 2.0.0 (skills
 * keep / change (new script) / add, templates gh (new endpoint preset, not editable, new policies) /
 * docs, dependency dep-b).
 */
async function seedCrm(): Promise<string> {
  await seedPlugin(env, { name: "dep-a", skills: ["dep-a-skill"], templates: false });
  await seedPlugin(env, { name: "dep-b", skills: ["dep-b-skill"], templates: false });
  const item = await seedPlugin(env, {
    name: "crm",
    skills: ["keep", "change", "drop"],
    templates: { gh: { defaultToolPolicies: { search: "allow", delete_all: "allow" } }, old: {} },
    dependencies: [{ name: "dep-a", version: "^1.0.0" }],
  });
  await seedPlugin(env, {
    name: "crm",
    addTo: item,
    version: "2.0.0",
    skills: ["keep", "change", "add"],
    skillScripts: { change: "print(2)\n" },
    templates: {
      gh: {
        endpoint: { url: "https://mcp2.example.com/mcp" },
        editableEndpoint: [],
        defaultToolPolicies: { search: "ask", delete_all: "deny" },
      },
      docs: {},
    },
    dependencies: [{ name: "dep-b", version: "^1.0.0" }],
  });
  return item;
}

describe("org plugin upgrade (spec §10)", { timeout: 90_000 }, () => {
  it("preview lists added / changed / removed skills, templates and dependencies; confirm applies them", async () => {
    const item = await seedCrm();
    const installId = await installOk(item, {
      connectors: { gh: tokenInput(), old: tokenInput() },
    });
    expect(await liveInstalls()).toEqual(["crm@1.0.0:installed", "dep-a@1.0.0:installed"]);
    const before = await skillRows();
    const id = (n: string) => before.find((s) => s.name === n)?.id as string;
    // An agent selects change and drop: drop is kept when it leaves the plugin
    await useSkills([id("change"), id("drop")]);
    const gh = await connectorOf(installId, "gh");
    const old = await connectorOf(installId, "old");
    // The org sets delete_all itself (admin): an upgrade keeps it
    const patch = await env.boss({
      method: "PATCH",
      url: `/api/v1/orgs/${env.orgId}/connectors/${gh.id}`,
      payload: { tools: { delete_all: { defaultPolicy: "ask" } } },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const ghSecrets = await secretsOf(gh.id);
    expect(ghSecrets).toHaveLength(1);
    expect((await viewOf(installId)).upgradeAvailable).toBe("2.0.0");

    const p = await previewOk(installId, "2.0.0");
    expect(p.from).toBe("1.0.0");
    expect(p.to).toBe("2.0.0");
    expect(p.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.components).toEqual([
      { kind: "plugin", ref: "dep-b", change: "added", detail: "installs 1.0.0" },
      { kind: "plugin", ref: "dep-a", change: "removed" },
      { kind: "skill", ref: "keep", change: "unchanged" },
      { kind: "skill", ref: "change", change: "changed" },
      { kind: "skill", ref: "add", change: "added" },
      { kind: "skill", ref: "drop", change: "removed" },
      { kind: "connector", ref: "gh", change: "changed" },
      { kind: "connector", ref: "docs", change: "added" },
      { kind: "connector", ref: "old", change: "removed" },
    ]);
    expect(p.inputs).toEqual({
      connectors: ["docs"],
      credentialsChanged: [],
      extensionConfig: false,
    });
    // The added template needs its credential, as at install
    const noInput = await upgrade(installId, { version: "2.0.0", diffHash: p.diffHash });
    expect(noInput.statusCode, noInput.body).toBe(400);
    expect(noInput.json().error.details[0].path).toBe("connectors.docs.credential");

    const r = await upgrade(installId, {
      version: "2.0.0",
      diffHash: p.diffHash,
      connectors: { docs: tokenInput() },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().install).toMatchObject({
      id: installId,
      version: "2.0.0",
      status: "installed",
      error: null,
      upgradeAvailable: null,
      deploymentPending: false,
    });

    // Skills: keep untouched, change got version 2 (same id), add created, drop kept (an agent uses it)
    const after = await skillRows();
    const row = (n: string) => after.find((s) => s.name === n);
    expect(row("keep")).toMatchObject({
      id: id("keep"),
      current_version: 1,
      catalog_version: "1.0.0",
    });
    expect(row("change")).toMatchObject({
      id: id("change"),
      current_version: 2,
      catalog_version: "2.0.0",
      deleted_at: null,
    });
    expect(row("add")).toMatchObject({
      current_version: 1,
      catalog_version: "2.0.0",
      deleted_at: null,
    });
    expect(row("drop")).toMatchObject({ id: id("drop"), deleted_at: null });
    const agent = await env.db
      .selectFrom("agents as a")
      .innerJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
      )
      .select(["v.definition", "a.current_version"])
      .executeTakeFirstOrThrow();
    expect(agent.current_version).toBe(1);
    expect((agent.definition as { skills: { orgSkills: string[] } }).skills.orgSkills).toEqual([
      id("change"),
      id("drop"),
    ]);
    // Connectors: gh gets the template-owned fields, keeps the org's policy and credential; old is
    // removed (no agent uses it); docs is created
    const gh2 = await connectorOf(installId, "gh");
    expect(gh2.id).toBe(gh.id);
    expect(gh2.endpoint).toMatchObject({ url: "https://mcp2.example.com/mcp" });
    expect(gh2.catalog_version).toBe("2.0.0");
    expect(gh2.template_tool_policies).toEqual({ search: "ask", delete_all: "deny" });
    expect(await toolPolicies(gh.id)).toEqual({
      search: "ask:template",
      delete_all: "ask:admin",
    });
    expect(await secretsOf(gh.id)).toEqual(ghSecrets);
    const oldNow = await env.db
      .selectFrom("connectors")
      .select("deleted_at")
      .where("id", "=", old.id)
      .executeTakeFirstOrThrow();
    expect(oldNow.deleted_at).not.toBeNull();
    const docs = await connectorOf(installId, "docs");
    expect(docs).toMatchObject({ catalog_version: "2.0.0", deleted_at: null });
    // Dependencies: dep-b installed by the install flow, dep-a uninstalled with its skill
    expect(await liveInstalls()).toEqual(["crm@2.0.0:installed", "dep-b@1.0.0:installed"]);
    expect(row("dep-a-skill")?.deleted_at).not.toBeNull();
    expect(row("dep-b-skill")?.deleted_at).toBeNull();
    // The ledger: old and dep-a left it, add / docs / dep-b joined; drop stays, marked dropped
    const comps = await env.db
      .selectFrom("plugin_install_components")
      .select(["kind", "ref", "created", "template_id", "dropped"])
      .where("install_id", "=", installId)
      .execute();
    const refs = comps
      .map((c) => `${c.kind}:${c.template_id ?? ""}:${c.created}:${c.dropped}`)
      .sort();
    expect(refs).toEqual(
      [
        "connector:docs:true:false",
        "connector:gh:true:false",
        "plugin::true:false",
        "skill::true:false",
        "skill::true:false",
        "skill::true:false",
        "skill::true:true",
      ].sort(),
    );
    expect(comps.find((c) => c.dropped)?.ref).toBe(id("drop"));
    expect(
      (r.json().install.components as { ref: string; dropped: boolean }[]).find(
        (c) => c.ref === id("drop"),
      )?.dropped,
    ).toBe(true);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.org_upgraded")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      itemId: item,
      name: "crm",
      from: "1.0.0",
      to: "2.0.0",
      components: p.components,
      kept: [{ kind: "skill", ref: id("drop"), reason: "used_by_agents" }],
    });
    // The org catalog shows the new version, nothing newer
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    const crm = (list.json().items as { name: string; installed: unknown }[]).find(
      (i) => i.name === "crm",
    );
    expect(crm?.installed).toEqual({
      pluginInstallId: installId,
      version: "2.0.0",
      upgradeAvailable: null,
    });
    // Uninstalling: the dropped skill is still this install's (kept for the agent, not pre_existing)
    const del = await uninstall(installId);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().kept).toEqual(
      expect.arrayContaining([{ kind: "skill", ref: id("drop"), reason: "used_by_agents" }]),
    );
    expect(
      (del.json().kept as { reason: string }[]).filter((k) => k.reason === "pre_existing"),
    ).toEqual([]);
  });

  it("default tool policies: a tool the template names takes its default unless the org set it; rolling back restores a dropped default", async () => {
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
    const installId = await installOk(item, { connectors: { gh: tokenInput() } });
    const gh = await connectorOf(installId, "gh");
    expect(await toolPolicies(gh.id)).toEqual({
      search: "deny:template",
      delete_all: "allow:template",
    });
    const up = await previewOk(installId, "1.1.0");
    expect((await upgrade(installId, { version: "1.1.0", diffHash: up.diffHash })).statusCode).toBe(
      200,
    );
    // 1.1.0 no longer names delete_all: back to the policy derived from its annotations
    const derived = await toolPolicies(gh.id);
    expect(derived.search).toBe("deny:template");
    expect(derived.delete_all).toMatch(/:derived$/);
    expect(derived.delete_all).not.toBe("allow:derived");
    // Rolling back to 1.0.0 restores the template default for the derived tool
    const back = await previewOk(installId, "1.0.0");
    expect(
      (await upgrade(installId, { version: "1.0.0", diffHash: back.diffHash })).statusCode,
    ).toBe(200);
    expect(await toolPolicies(gh.id)).toEqual({
      search: "deny:template",
      delete_all: "allow:template",
    });
    // A policy the org set stays through upgrades
    const patch = await env.boss({
      method: "PATCH",
      url: `/api/v1/orgs/${env.orgId}/connectors/${gh.id}`,
      payload: { tools: { search: { defaultPolicy: "ask" } } },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const again = await previewOk(installId, "1.1.0");
    expect(
      (await upgrade(installId, { version: "1.1.0", diffHash: again.diffHash })).statusCode,
    ).toBe(200);
    expect((await toolPolicies(gh.id)).search).toBe("ask:admin");
  });

  it("a declarative plugin can roll back to an older version: the skill gets the old content as a new version", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes"],
      templates: false,
      skillScripts: { notes: "print(11)\n" },
    });
    const installId = await installOk(item, { version: "1.1.0" });
    expect((await viewOf(installId)).upgradeAvailable).toBeNull();
    const p = await previewOk(installId, "1.0.0");
    expect(p.components).toEqual([{ kind: "skill", ref: "notes", change: "changed" }]);
    const r = await upgrade(installId, { version: "1.0.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().install).toMatchObject({ version: "1.0.0", upgradeAvailable: "1.1.0" });
    const [notes] = await skillRows();
    expect(notes).toMatchObject({ current_version: 2, catalog_version: "1.0.0" });
    // The same version again is not a target
    const same = await preview(installId, "1.0.0");
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe("plugin.upgrade_target_invalid");
    expect(same.json().error.details).toEqual([{ reason: "same_version", version: "1.0.0" }]);
  });

  it("a plugin with an extension can move only to the deployment's version, and shows deploymentPending until then", async () => {
    // fake-tools-ui is loaded from the startup config at 0.1.0
    const item = await seedPlugin(env, {
      name: "fake-tools-ui",
      extension: true,
      skills: [],
      templates: false,
      version: "0.0.9",
    });
    await seedPlugin(env, {
      name: "fake-tools-ui",
      addTo: item,
      version: "0.1.0",
      extension: true,
      skills: [],
      templates: false,
    });
    await seedPlugin(env, {
      name: "fake-tools-ui",
      addTo: item,
      version: "0.2.0",
      extension: true,
      skills: [],
      templates: false,
    });
    const installId = await installOk(item, { version: "0.0.9" });
    expect(await viewOf(installId)).toMatchObject({
      upgradeAvailable: "0.1.0",
      deploymentPending: true,
    });
    const newer = await preview(installId, "0.2.0");
    expect(newer.statusCode, newer.body).toBe(409);
    expect(newer.json().error.code).toBe("plugin.upgrade_target_invalid");
    expect(newer.json().error.message).toContain("at version 0.1.0");
    expect(newer.json().error.message).toContain("catalog version 0.1.0");
    expect(newer.json().error.details).toEqual([
      { reason: "deployment_version", deploymentVersion: "0.1.0", allowedVersion: "0.1.0" },
    ]);
    const p = await previewOk(installId, "0.1.0");
    expect(p.components).toEqual([
      { kind: "extension", ref: "fake-tools-ui", change: "changed", detail: "0.0.9 -> 0.1.0" },
    ]);
    const r = await upgrade(installId, { version: "0.1.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().install).toMatchObject({
      version: "0.1.0",
      upgradeAvailable: null,
      deploymentPending: false,
    });
    // It cannot roll back on its own
    const back = await preview(installId, "0.0.9");
    expect(back.statusCode).toBe(409);
    expect(back.json().error.code).toBe("plugin.upgrade_target_invalid");
  });

  it("the target is the catalog version carrying the deployment's extension package (sha256), not a newer import of the same extension version", async () => {
    const { itemId, sha256 } = await importDeployedPlugin(env, "upg-ext");
    // Two other packages of the same extension (copies of the deployed row under other hashes)
    for (const other of ["e".repeat(64), "f".repeat(64)]) {
      await sql`INSERT INTO capybara.extension_packages
        SELECT (jsonb_populate_record(NULL::capybara.extension_packages,
          to_jsonb(p) || jsonb_build_object('sha256', ${other}::text))).*
        FROM capybara.extension_packages p WHERE p.sha256 = ${sha256}
        ON CONFLICT DO NOTHING`.execute(env.db);
    }
    await seedPlugin(env, {
      name: "upg-ext",
      addTo: itemId,
      version: "0.9.0",
      extension: true,
      skills: [],
      templates: false,
      extensionSha256: "e".repeat(64),
    });
    // Re-imported later with other extension bytes at the same version
    await seedPlugin(env, {
      name: "upg-ext",
      addTo: itemId,
      version: "1.0.0+sha256.ffffffffffff",
      extension: true,
      skills: [],
      templates: false,
      extensionSha256: "f".repeat(64),
    });
    const deployed = await env.db
      .selectFrom("catalog_item_versions")
      .select("version")
      .where("item_id", "=", itemId)
      .where("extension_sha256", "=", sha256)
      .executeTakeFirstOrThrow();
    expect(deployed.version).toBe("1.0.0");
    const installId = await installOk(itemId, { version: "0.9.0" });
    expect(await viewOf(installId)).toMatchObject({
      upgradeAvailable: "1.0.0",
      deploymentPending: true,
    });
    const wrong = await preview(installId, "1.0.0+sha256.ffffffffffff");
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("plugin.upgrade_target_invalid");
    const p = await previewOk(installId, "1.0.0");
    const r = await upgrade(installId, { version: "1.0.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().install).toMatchObject({ version: "1.0.0", deploymentPending: false });
    // Disabled on the deployment: no target, nothing pending
    const off = await env.root({ method: "POST", url: "/api/v1/admin/extensions/upg-ext/disable" });
    expect(off.statusCode, off.body).toBe(200);
    expect(await viewOf(installId)).toMatchObject({
      upgradeAvailable: null,
      deploymentPending: false,
    });
  });

  it("a changed template whose auth needs other credentials: listed in credentialsChanged, required, and replaced", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [], templates: { gh: {} } });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "1.1.0",
      skills: [],
      templates: { gh: { auth: { type: "headers", ownership: "org", names: ["X-Key"] } } },
    });
    const installId = await installOk(item, { connectors: { gh: tokenInput() } });
    const gh = await connectorOf(installId, "gh");
    const oldSecrets = await secretsOf(gh.id);
    const p = await previewOk(installId, "1.1.0");
    expect(p.components).toEqual([
      { kind: "connector", ref: "gh", change: "changed", detail: "credentials change" },
    ]);
    expect(p.inputs).toEqual({
      connectors: [],
      credentialsChanged: ["gh"],
      extensionConfig: false,
    });
    const missing = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details[0].path).toBe("connectors.gh.credential");
    const r = await upgrade(installId, {
      version: "1.1.0",
      diffHash: p.diffHash,
      connectors: { gh: { credential: { headers: { "X-Key": "k-123456789012" } } } },
    });
    expect(r.statusCode, r.body).toBe(200);
    const gh2 = await connectorOf(installId, "gh");
    expect(gh2.auth).toEqual({ type: "headers", ownership: "org", names: ["X-Key"] });
    const now = await secretsOf(gh.id);
    expect(now).toHaveLength(1);
    expect(now).not.toEqual(oldSecrets);
  });

  it("an added personal static-auth template needs the installer's credential, as at install (final review I2)", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [], templates: { gh: {} } });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "1.1.0",
      skills: [],
      templates: { gh: {}, docs: { auth: { type: "bearer", ownership: "personal" } } },
    });
    const installId = await installOk(item, { connectors: { gh: tokenInput() } });
    const p = await previewOk(installId, "1.1.0");
    expect(p.inputs.connectors).toEqual(["docs"]);
    const missing = await upgrade(installId, {
      version: "1.1.0",
      diffHash: p.diffHash,
      connectors: { docs: { endpoint: { url: env.mcp.url } } },
    });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.details[0].path).toBe("connectors.docs.credential");
    expect(await liveInstalls()).toEqual(["crm@1.0.0:installed"]);
    const r = await upgrade(installId, {
      version: "1.1.0",
      diffHash: p.diffHash,
      connectors: { docs: tokenInput() },
    });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("the preview carries the target version's templates named in its inputs, also when the latest version lacks them", async () => {
    const item = await seedPlugin(env, { name: "crm", skills: [], templates: { gh: {} } });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "1.1.0",
      skills: [],
      templates: {
        gh: { auth: { type: "headers", ownership: "org", names: ["X-Key"] } },
        docs: {},
      },
    });
    // The latest version has neither the new gh auth nor docs
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "2.0.0",
      skills: [],
      templates: false,
    });
    const installId = await installOk(item, { connectors: { gh: tokenInput() } });
    const p = await previewOk(installId, "1.1.0");
    expect(p.inputs).toMatchObject({ connectors: ["docs"], credentialsChanged: ["gh"] });
    expect(p.templates.map((t) => t.id).sort()).toEqual(["docs", "gh"]);
    const gh = p.templates.find((t) => t.id === "gh");
    expect(gh).toMatchObject({
      plugin: "fake-connector",
      auth: { type: "headers", ownership: "org", names: ["X-Key"] },
      ownership: "org",
    });
    expect(gh?.displayName).toBeTruthy();
    // No input needed: no templates
    const none = await previewOk(installId, "2.0.0");
    expect(none.templates).toEqual([]);
  });

  it("an added extension is enabled (its org config may be given); rolling back to a version without it disables it", async () => {
    // fake-tools-ui is loaded from the startup config at 0.1.0
    const item = await seedPlugin(env, {
      name: "fake-tools-ui",
      skills: ["notes"],
      templates: false,
      version: "0.0.1",
    });
    await seedPlugin(env, {
      name: "fake-tools-ui",
      addTo: item,
      version: "0.1.0",
      extension: true,
      skills: ["notes"],
      templates: false,
    });
    const installId = await installOk(item, { version: "0.0.1" });
    const p = await previewOk(installId, "0.1.0");
    expect(p.components).toEqual([
      { kind: "extension", ref: "fake-tools-ui", change: "added" },
      { kind: "skill", ref: "notes", change: "unchanged" },
    ]);
    expect(p.inputs.extensionConfig).toBe(true);
    const r = await upgrade(installId, { version: "0.1.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(200);
    const enabled = () =>
      env.db
        .selectFrom("extension_org_configs")
        .select("plugin")
        .where("org_id", "=", env.orgId)
        .where("enabled", "=", true)
        .execute();
    expect(await enabled()).toEqual([{ plugin: "fake-tools-ui" }]);
    const back = await previewOk(installId, "0.0.1");
    expect(back.components[0]).toEqual({
      kind: "extension",
      ref: "fake-tools-ui",
      change: "removed",
    });
    const b = await upgrade(installId, { version: "0.0.1", diffHash: back.diffHash });
    expect(b.statusCode, b.body).toBe(200);
    expect(await enabled()).toEqual([]);
  });

  it("rolling back across a dropped connector: the template comes back onto the kept connector, un-dropped", async () => {
    const item = await seedPlugin(env, {
      name: "crm",
      skills: [],
      templates: { gh: {}, docs: {} },
    });
    await seedPlugin(env, {
      name: "crm",
      addTo: item,
      version: "2.0.0",
      skills: [],
      templates: { docs: {} },
    });
    const installId = await installOk(item, {
      version: "1.0.0",
      connectors: { gh: tokenInput(), docs: tokenInput() },
    });
    const gh = await connectorOf(installId, "gh");
    const ghSecrets = await secretsOf(gh.id);
    // An agent uses gh's connector: v2 drops the template, the connector is kept
    const ag = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "Sales",
          instructions: "x",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "connector", connectorId: gh.id, tools: "all" }],
        },
        visibility: "org",
      },
    });
    expect(ag.statusCode, ag.body).toBe(201);
    const up = await previewOk(installId, "2.0.0");
    expect(up.components).toContainEqual({ kind: "connector", ref: "gh", change: "removed" });
    const u = await upgrade(installId, { version: "2.0.0", diffHash: up.diffHash });
    expect(u.statusCode, u.body).toBe(200);
    const ghRow = () =>
      env.db
        .selectFrom("plugin_install_components")
        .select(["ref", "created", "dropped"])
        .where("install_id", "=", installId)
        .where("kind", "=", "connector")
        .where("template_id", "=", "gh")
        .execute();
    expect(await ghRow()).toEqual([{ ref: gh.id, created: true, dropped: true }]);

    // Back to v1: gh is a changed template on the kept connector (no slug clash, no second one)
    const back = await previewOk(installId, "1.0.0");
    expect(back.components).toContainEqual({ kind: "connector", ref: "gh", change: "changed" });
    expect(back.inputs).toEqual({ connectors: [], credentialsChanged: [], extensionConfig: false });
    const b = await upgrade(installId, { version: "1.0.0", diffHash: back.diffHash });
    expect(b.statusCode, b.body).toBe(200);
    expect(await ghRow()).toEqual([{ ref: gh.id, created: true, dropped: false }]);
    const live = await env.db
      .selectFrom("connectors")
      .select(["id", "catalog_version"])
      .where("org_id", "=", env.orgId)
      .where("deleted_at", "is", null)
      .orderBy("id")
      .execute();
    expect(live).toHaveLength(2);
    expect(live.find((c) => c.id === gh.id)?.catalog_version).toBe("1.0.0");
    expect(await secretsOf(gh.id)).toEqual(ghSecrets);
    // Still this install's: an uninstall reports it kept for the agent, not pre_existing
    const del = await uninstall(installId);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().kept).toEqual([{ kind: "connector", ref: gh.id, reason: "used_by_agents" }]);
  });

  it("an extension a removal keeps because it is still used (used_by_connectors) stays in the ledger, dropped", async () => {
    // fake-tools-ui is loaded from the startup config at 0.1.0
    const item = await seedPlugin(env, {
      name: "fake-tools-ui",
      skills: [],
      templates: false,
      version: "0.0.1",
    });
    await seedPlugin(env, {
      name: "fake-tools-ui",
      addTo: item,
      version: "0.1.0",
      extension: true,
      skills: [],
      templates: false,
    });
    const installId = await installOk(item, { version: "0.0.1" });
    const up = await previewOk(installId, "0.1.0");
    expect((await upgrade(installId, { version: "0.1.0", diffHash: up.diffHash })).statusCode).toBe(
      200,
    );
    const extRow = () =>
      env.db
        .selectFrom("plugin_install_components")
        .select(["ref", "created", "dropped"])
        .where("install_id", "=", installId)
        .where("kind", "=", "extension")
        .execute();
    const enabled = () =>
      env.db
        .selectFrom("extension_org_configs")
        .select("plugin")
        .where("org_id", "=", env.orgId)
        .where("enabled", "=", true)
        .execute();
    expect(await extRow()).toEqual([{ ref: "fake-tools-ui", created: true, dropped: false }]);
    // Rolling back while its connectors are in use: the extension stays enabled and this install's
    const real = PluginInstaller.prototype.decideRemovalIn;
    vi.spyOn(PluginInstaller.prototype, "decideRemovalIn").mockImplementation(async function (
      this: PluginInstaller,
      ...a: Parameters<PluginInstaller["decideRemovalIn"]>
    ) {
      if (a[3].kind === "extension") return "used_by_connectors";
      return real.apply(this, a);
    });
    const back = await previewOk(installId, "0.0.1");
    const b = await upgrade(installId, { version: "0.0.1", diffHash: back.diffHash });
    expect(b.statusCode, b.body).toBe(200);
    expect(await extRow()).toEqual([{ ref: "fake-tools-ui", created: true, dropped: true }]);
    expect(await enabled()).toEqual([{ plugin: "fake-tools-ui" }]);
    vi.restoreAllMocks();
    // Upgrading again brings it back: un-dropped, still created by this install
    const again = await previewOk(installId, "0.1.0");
    const g = await upgrade(installId, { version: "0.1.0", diffHash: again.diffHash });
    expect(g.statusCode, g.body).toBe(200);
    expect(await extRow()).toEqual([{ ref: "fake-tools-ui", created: true, dropped: false }]);
    // Uninstalling (nothing uses it now) disables it
    expect((await uninstall(installId)).statusCode).toBe(200);
    expect(await enabled()).toEqual([]);
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
    const installId = await installOk(item, { version: "1.0.0" });
    const p = await previewOk(installId, "1.1.0");
    const before = await snapshot();
    const fake = await upgrade(installId, { version: "1.1.0", diffHash: "0".repeat(64) });
    expect(fake.statusCode).toBe(409);
    expect(fake.json().error.code).toBe("plugin.upgrade_stale");
    // The hash of another target
    const other = await upgrade(installId, { version: "1.2.0", diffHash: p.diffHash });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("plugin.upgrade_stale");
    // The install's components changed since the preview (a skill left the ledger)
    await env.db
      .deleteFrom("plugin_install_components")
      .where("install_id", "=", installId)
      .where("kind", "=", "skill")
      .execute();
    const changed = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("plugin.upgrade_stale");
    const after = await snapshot();
    expect(after.skills).toEqual(before.skills);
    expect(after.installs).toEqual(before.installs);
  });

  it("needs_approval without a grant: 202 with a request for the target version; after approval the upgrade runs; disabled is refused", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "more"],
      templates: false,
    });
    const installId = await installOk(item);
    await setPolicy(env, item, "needs_approval");
    const p = await previewOk(installId, "1.1.0");
    const pend = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(pend.statusCode, pend.body).toBe(202);
    expect(pend.json().request).toMatchObject({ stage: "deployment", status: "pending" });
    const req = await env.db
      .selectFrom("catalog_requests")
      .select(["id", "version"])
      .executeTakeFirstOrThrow();
    expect(req.version).toBe("1.1.0");
    expect(await liveInstalls()).toEqual(["notes@1.0.0:installed"]);
    const d = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/requests/${req.id}/decide`,
      payload: { decision: "approve" },
    });
    expect(d.statusCode, d.body).toBe(200);
    const ok = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await liveInstalls()).toEqual(["notes@1.1.0:installed"]);

    await setPolicy(env, item, "disabled");
    const off = await preview(installId, "1.0.0");
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe("catalog.item_disabled");
    const off2 = await upgrade(installId, { version: "1.0.0", diffHash: p.diffHash });
    expect(off2.json().error.code).toBe("catalog.item_disabled");
  });

  it("members cannot preview or upgrade", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes"],
      templates: false,
    });
    const installId = await installOk(item);
    const r = await env.mem({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}/upgrade/preview`,
      payload: { version: "1.1.0" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("a skill the target brings that the org already has (its own): the preview is 409 plugin.skill_conflict", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "journal"],
      templates: false,
    });
    const installId = await installOk(item);
    await ownSkill("journal");
    const r = await preview(installId, "1.1.0");
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toEqual({
      code: "plugin.skill_conflict",
      message:
        'Skill "journal" already exists in this org (source: the org\'s own skill). Remove or rename it, then install again.',
      details: [{ skill: "journal", source: { kind: "org" } }],
    });
  });

  it("a plugin another install depends on cannot move outside that dependency's range", async () => {
    const lib = await seedPlugin(env, { name: "lib", skills: ["lib"], templates: false });
    await seedPlugin(env, {
      name: "lib",
      addTo: lib,
      version: "2.0.0",
      skills: ["lib"],
      templates: false,
      skillScripts: { lib: "x\n" },
    });
    const app = await seedPlugin(env, {
      name: "app",
      skills: ["app"],
      templates: false,
      dependencies: [{ name: "lib", version: "^1.0.0" }],
    });
    await installOk(app);
    const libInstall = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("item_id", "=", lib)
      .executeTakeFirstOrThrow();
    const r = await preview(libInstall.id, "2.0.0");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("plugin.upgrade_target_invalid");
    expect(r.json().error.message).toContain(
      "app installed in this organization depends on lib@^1.0.0",
    );
    expect(r.json().error.details).toEqual([
      { reason: "dependent_range", dependent: "app", range: "^1.0.0", version: "2.0.0" },
    ]);
  });
});

describe("org plugin upgrade: failure rollback (Review Focus 3)", { timeout: 90_000 }, () => {
  it("the connector step fails after skills got new versions and a dependency was installed: the org ends exactly as before", async () => {
    const item = await seedCrm();
    const installId = await installOk(item, {
      connectors: { gh: tokenInput(), old: tokenInput() },
    });
    const p = await previewOk(installId, "2.0.0");
    const before = await snapshot();
    // The changed connector is written, then the step fails
    const real = ConnectorsService.prototype.applyTemplateIn;
    vi.spyOn(ConnectorsService.prototype, "applyTemplateIn").mockImplementation(async function (
      this: ConnectorsService,
      ...args: Parameters<ConnectorsService["applyTemplateIn"]>
    ) {
      await real.apply(this, args);
      throw new Error("injected connector failure");
    });
    const r = await upgrade(installId, {
      version: "2.0.0",
      diffHash: p.diffHash,
      connectors: { docs: tokenInput() },
    });
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.code).toBe("plugin.upgrade_failed");
    expect(r.json().error.details[0]).toMatchObject({
      step: "connectors",
      code: "internal",
      rolledBack: true,
    });
    const after = await snapshot();
    expect(after.skills).toEqual(before.skills);
    expect(after.versions).toEqual(before.versions);
    expect(after.components).toEqual(before.components);
    expect(after.connectors.filter((c) => c.deleted_at === null)).toEqual(
      before.connectors.filter((c) => c.deleted_at === null),
    );
    expect(
      after.tools.filter((t) => before.tools.some((b) => b.connector_id === t.connector_id)),
    ).toEqual(before.tools);
    expect(after.secrets.filter((s) => before.secrets.some((b) => b.key === s.key))).toEqual(
      before.secrets,
    );
    expect(after.enabled).toEqual(before.enabled);
    // The dependency the upgrade installed (dep-b) is gone again; the install is back at 1.0.0
    expect(await liveInstalls()).toEqual(["crm@1.0.0:installed", "dep-a@1.0.0:installed"]);
    const row = await env.db
      .selectFrom("plugin_installs")
      .select(["status", "version", "error", "upgrade"])
      .where("id", "=", installId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "installed",
      version: "1.0.0",
      error: { step: "connectors", code: "internal" },
      upgrade: null,
    });
    const failedAudit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.org_upgrade_failed")
      .executeTakeFirstOrThrow();
    // What it undid: the dependency install, the skill versions and the skill it created, docs
    const undone = (failedAudit.detail as { rolledBack: { op: string; kind?: string }[] })
      .rolledBack;
    expect(undone.filter((x) => x.op === "created").map((x) => x.kind)).toEqual([
      "plugin",
      "skill",
      "connector",
    ]);
    expect(undone.filter((x) => x.op === "skill_version")).toHaveLength(1);
    expect(await auditActions(env)).toContain("plugin.org_upgrade_failed");
    // The docs connector the upgrade created was removed
    const live = await env.db
      .selectFrom("connectors")
      .select("id")
      .where("deleted_at", "is", null)
      .execute();
    expect(live).toHaveLength(2);
    // And it can be upgraded afterwards
    vi.restoreAllMocks();
    const again = await previewOk(installId, "2.0.0");
    const ok = await upgrade(installId, {
      version: "2.0.0",
      diffHash: again.diffHash,
      connectors: { docs: tokenInput() },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await viewOf(installId)).error).toBeNull();
  });

  it("creating an added connector fails (the remote refuses the credential): everything before it is undone", async () => {
    const item = await seedCrm();
    const installId = await installOk(item, {
      connectors: { gh: tokenInput(), old: tokenInput() },
    });
    const p = await previewOk(installId, "2.0.0");
    const before = await snapshot();
    const r = await upgrade(installId, {
      version: "2.0.0",
      diffHash: p.diffHash,
      connectors: { docs: tokenInput("wrong-token") },
    });
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.details[0]).toMatchObject({
      step: "connectors",
      code: "connector.connect_failed",
      rolledBack: true,
    });
    const after = await snapshot();
    expect(after.skills).toEqual(before.skills);
    expect(after.versions).toEqual(before.versions);
    expect(after.components).toEqual(before.components);
    expect(after.connectors).toEqual(before.connectors);
    expect(await liveInstalls()).toEqual(["crm@1.0.0:installed", "dep-a@1.0.0:installed"]);
  });
});

describe("org plugin upgrade: concurrency (Review Focus 4)", { timeout: 90_000 }, () => {
  /** Holds the upgrade inside its skills step (at skill `skill`) until `release` is called. */
  function holdSkillsStep(skill = "notes"): { reached: Promise<void>; release: () => void } {
    let release = () => {};
    let reached = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const at = new Promise<void>((r) => {
      reached = r;
    });
    const skills = env.k.skills;
    const real = skills.createVersionFromFiles.bind(skills);
    vi.spyOn(skills, "createVersionFromFiles").mockImplementation(async (...a) => {
      if (a[2].name === skill) {
        reached();
        await gate;
      }
      return real(...a);
    });
    return { reached: at, release };
  }

  it("an uninstall or a second upgrade during an upgrade gets 409 plugin.install_in_progress; the upgrade completes", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes"],
      templates: false,
      skillScripts: { notes: "print(2)\n" },
    });
    const installId = await installOk(item);
    const p = await previewOk(installId, "1.1.0");
    const hold = holdSkillsStep();
    const running = upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    await hold.reached;
    expect((await viewOf(installId)).status).toBe("upgrading");
    const del = await uninstall(installId);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("plugin.install_in_progress");
    const second = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("plugin.install_in_progress");
    const second2 = await preview(installId, "1.1.0");
    expect(second2.json().error.code).toBe("plugin.install_in_progress");
    hold.release();
    const r = await running;
    expect(r.statusCode, r.body).toBe(200);
    expect(await liveInstalls()).toEqual(["notes@1.1.0:installed"]);
    const [notes] = await skillRows();
    expect(notes?.current_version).toBe(2);
  });

  it("two upgrades started at once: one wins, the other gets 409, no half state", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes"],
      templates: false,
      skillScripts: { notes: "print(2)\n" },
    });
    const installId = await installOk(item);
    const p = await previewOk(installId, "1.1.0");
    const results = await Promise.all([
      upgrade(installId, { version: "1.1.0", diffHash: p.diffHash }),
      upgrade(installId, { version: "1.1.0", diffHash: p.diffHash }),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(200);
    // The loser saw it upgrading (409 in progress) or already upgraded (409 stale)
    expect(codes[1]).toBe(409);
    const loser = results.find((r) => r.statusCode === 409);
    expect(["plugin.install_in_progress", "plugin.upgrade_stale"]).toContain(
      loser?.json().error.code,
    );
    const [notes] = await skillRows();
    expect(notes?.current_version).toBe(2);
    expect(await liveInstalls()).toEqual(["notes@1.1.0:installed"]);
  });

  it("an upgrade interrupted midway: 409 until catalog.staleInstallMinutes, then the next preview or uninstall undoes it", async () => {
    await seedPlugin(env, { name: "dep-b", skills: ["dep-b-skill"], templates: false });
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "extra"],
      templates: false,
      skillScripts: { notes: "print(2)\n" },
      dependencies: [{ name: "dep-b", version: "*" }],
    });
    const installId = await installOk(item);
    const before = await snapshot();
    const p = await previewOk(installId, "1.1.0");
    // A crash after the skills step: the rollback never runs (simulated by failing it)
    vi.spyOn(PluginInstaller.prototype, "undoUpgradeIn").mockRejectedValueOnce(
      new Error("replica gone"),
    );
    // Fail at the finish step (after the dependency and the skills were journaled)
    vi.spyOn(PluginInstaller.prototype, "agentRefs").mockRejectedValueOnce(new Error("boom"));
    const r = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.details[0]).toMatchObject({ step: "finish", rolledBack: false });
    expect(await liveInstalls()).toEqual(["dep-b@1.0.0:installed", "notes@1.0.0:upgrading"]);
    vi.restoreAllMocks();
    // Not stale yet
    expect((await preview(installId, "1.1.0")).json().error.code).toBe(
      "plugin.install_in_progress",
    );
    expect((await uninstall(installId)).json().error.code).toBe("plugin.install_in_progress");
    // Past catalog.staleInstallMinutes: the preview undoes it first
    await backdateUpgrade(installId);
    const again = await previewOk(installId, "1.1.0");
    expect(again.from).toBe("1.0.0");
    const after = await snapshot();
    expect(after.skills).toEqual(before.skills);
    expect(after.versions).toEqual(before.versions);
    expect(after.components).toEqual(before.components);
    expect(await liveInstalls()).toEqual(["notes@1.0.0:installed"]);
    expect((await viewOf(installId)).error).toEqual({ step: "interrupted", code: "internal" });
  });

  it("an upgrade whose journal another request cleaned up meanwhile undoes only its own unjournaled step", async () => {
    await seedPlugin(env, { name: "dep-b", skills: ["dep-b-skill"], templates: false });
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes"],
      templates: false,
      skillScripts: { notes: "print(2)\n" },
      dependencies: [{ name: "dep-b", version: "*" }],
    });
    const installId = await installOk(item);
    const before = await snapshot();
    const p = await previewOk(installId, "1.1.0");
    // Held in the skills step (dep-b is installed and journaled); meanwhile the upgrade is treated
    // as interrupted and cleaned up by another request
    const hold = holdSkillsStep();
    const running = upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    await hold.reached;
    await backdateUpgrade(installId);
    const other = await preview(installId, "1.1.0");
    expect(other.statusCode, other.body).toBe(200);
    expect(await liveInstalls()).toEqual(["notes@1.0.0:installed"]);
    hold.release();
    const r = await running;
    expect(r.statusCode, r.body).toBe(502);
    // The skill version it added after the cleanup is undone; nothing is undone twice
    const after = await snapshot();
    expect(after.skills).toEqual(before.skills);
    expect(after.versions).toEqual(before.versions);
    expect(after.components).toEqual(before.components);
    expect(await liveInstalls()).toEqual(["notes@1.0.0:installed"]);
    const uninstalls = await env.db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "=", "plugin.org_uninstalled")
      .execute();
    expect(uninstalls).toHaveLength(1);
    const failed = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.org_upgrade_failed")
      .orderBy("id")
      .execute();
    expect(failed.map((f) => (f.detail as { rolledBack: { op: string }[] }).rolledBack)).toEqual([
      [{ op: "created", kind: "plugin", ref: expect.any(String) }],
      [{ op: "skill_version", ref: expect.any(String), version: 2 }],
    ]);
    expect((await viewOf(installId)).error).toEqual({ step: "interrupted", code: "internal" });
  });

  it("uninstalling an interrupted upgrade past the timeout undoes it and removes the install", async () => {
    const item = await seedPlugin(env, { name: "notes", skills: ["notes"], templates: false });
    await seedPlugin(env, {
      name: "notes",
      addTo: item,
      version: "1.1.0",
      skills: ["notes", "extra"],
      templates: false,
      skillScripts: { notes: "print(2)\n" },
    });
    const installId = await installOk(item);
    const p = await previewOk(installId, "1.1.0");
    vi.spyOn(PluginInstaller.prototype, "undoUpgradeIn").mockRejectedValueOnce(
      new Error("replica gone"),
    );
    vi.spyOn(PluginInstaller.prototype, "agentRefs").mockRejectedValueOnce(new Error("boom"));
    const r = await upgrade(installId, { version: "1.1.0", diffHash: p.diffHash });
    expect(r.statusCode, r.body).toBe(502);
    vi.restoreAllMocks();
    expect((await skillRows()).map((s) => `${s.name}:${s.current_version}`)).toEqual([
      "extra:1",
      "notes:2",
    ]);
    await backdateUpgrade(installId);
    const del = await uninstall(installId);
    expect(del.statusCode, del.body).toBe(200);
    expect(await liveInstalls()).toEqual([]);
    // The upgrade's skill and version are undone, then the uninstall removed the plugin's skill
    const rows = await skillRows();
    expect(rows.every((s) => s.deleted_at !== null)).toBe(true);
    const versions = await env.db.selectFrom("skill_versions").select("version").execute();
    expect(versions.map((v) => v.version).sort()).toEqual([1, 1]);
  });
});
