import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallFailure, PluginInstaller, planActions } from "../../src/catalog/plugin-install.js";
import { ApiError } from "../../src/errors.js";
import { runOutsideTransaction } from "../../src/infra/database/transaction-host.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { usableSkills } from "../../src/skills/usable.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  install,
  legacyCopies,
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

const pluginBody = (token = MCP_TOKEN) => ({
  connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token } } },
});

/** The org's enabled extensions, `fake-connector` aside unless asked (every test org has it on). */
async function enabledPlugins(withConnector = false): Promise<string[]> {
  const rows = await env.db
    .selectFrom("extension_org_configs")
    .select("plugin")
    .where("org_id", "=", env.orgId)
    .where("enabled", "=", true)
    .$if(!withConnector, (q) => q.where("plugin", "!=", "fake-connector"))
    .orderBy("plugin")
    .execute();
  return rows.map((r) => r.plugin);
}

const liveConnectors = () =>
  env.db.selectFrom("connectors").select("id").where("deleted_at", "is", null).execute();

/** The org item detail's connector templates as `[id, connected]` pairs. */
async function templateConnections(itemId: string): Promise<[string, boolean][]> {
  const d = await env.boss({
    method: "GET",
    url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}`,
  });
  expect(d.statusCode, d.body).toBe(200);
  return (d.json() as { templates: { id: string; connected: boolean }[] }).templates.map(
    (t) => [t.id, t.connected] as const,
  );
}
const liveSkills = () =>
  env.db.selectFrom("skills").select(["id", "name"]).where("deleted_at", "is", null).execute();
/** The org's usable skills as `<origin>:<name>` (phase 2: platform skills on in the org included). */
const usableNames = async () =>
  (await usableSkills(env.db, env.orgId)).map((s) => `${s.origin}:${s.name}`);

async function enable(plugin: string): Promise<void> {
  const r = await env.boss({
    method: "PUT",
    url: `/api/v1/orgs/${env.orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
}

/** Installs `fake-connector` (its extension too) and returns the item and its connector id. */
async function installConnectorPlugin(): Promise<{ itemId: string; connectorId: string }> {
  const itemId = await seedPlugin(env, { name: "fake-connector", extension: true });
  await env.db
    .deleteFrom("extension_org_configs")
    .where("org_id", "=", env.orgId)
    .where("plugin", "=", "fake-connector")
    .execute();
  const r = await install(env.boss, env, itemId, pluginBody());
  expect(r.statusCode, r.body).toBe(201);
  const [conn] = await liveConnectors();
  return { itemId, connectorId: conn?.id as string };
}

/**
 * Leaves an agent on (it implicitly uses every connector), switches the plugin off and confirms
 * the preview: the connector is kept for the agent, so the next install would reuse it.
 */
async function switchOffKeepingConnector(itemId: string): Promise<void> {
  const agent = await env.boss({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "x",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  const preview = await env.boss({
    method: "PUT",
    url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
    payload: { enabled: false },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const done = await env.boss({
    method: "PUT",
    url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/switch`,
    payload: { enabled: false, confirm: (preview.json() as { confirm: string }).confirm },
  });
  expect(done.statusCode, done.body).toBe(200);
  expect(await liveConnectors()).toHaveLength(1);
}

async function uninstallOf(
  installId: string,
): Promise<{ removed: unknown[]; kept: { kind: string; ref: string; reason: string }[] }> {
  const r = await env.boss({
    method: "DELETE",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installId}`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe("org plugin install", { timeout: 60_000 }, () => {
  it("enables the plugin's extension, creates the template's connector (credential in secrets, default policies), records each component; its skill is the platform's (no org row)", async () => {
    const appId = await seedPlugin(env, { name: "fake-tools-ui", extension: true });
    const r = await install(env.boss, env, appId, pluginBody());
    expect(r.statusCode, r.body).toBe(201);
    const installId = r.json().installed.pluginInstallId as string;
    expect(await enabledPlugins()).toEqual(["fake-tools-ui"]);
    const [c] = await env.db
      .selectFrom("connectors")
      .select(["id", "catalog_item_id", "catalog_version", "slug"])
      .where("deleted_at", "is", null)
      .execute();
    expect(c).toMatchObject({
      catalog_item_id: appId,
      catalog_version: "1.0.0",
      slug: "github",
    });
    const search = await env.db
      .selectFrom("connector_tools")
      .select(["default_policy", "policy_source"])
      .where("connector_id", "=", c?.id as string)
      .where("name", "=", "search")
      .executeTakeFirstOrThrow();
    expect(search).toEqual({ default_policy: "allow", policy_source: "template" });
    const secrets = await env.db.selectFrom("secrets").select("key").execute();
    expect(secrets.some((s) => s.key.includes(c?.id as string))).toBe(true);
    // phase 2: the plugin's skill is a platform component, on in the org while the plugin is
    expect(await liveSkills()).toEqual([]);
    expect(await usableNames()).toEqual(["platform:pdf-tools"]);
    const list = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs`,
    });
    const [view] = (
      list.json() as { installs: { id: string; status: string; components: unknown[] }[] }
    ).installs;
    expect(view).toMatchObject({ id: installId, status: "installed" });
    expect(view?.components).toHaveLength(2);
    expect(await auditActions(env)).toContain("plugin.org_installed");
    // 同一应用不能再装
    const again = await install(env.boss, env, appId, pluginBody());
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("plugin.already_installed");
  });

  it("the connector step fails: the extension it enabled is undone, the install is failed (step and code only), it can be installed again", async () => {
    await enable("fake-tools-ui");
    const appId = await seedPlugin(env, { name: "fake-dep-provider", extension: true });
    const r = await install(env.boss, env, appId, pluginBody("wrong-token"));
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.code).toBe("plugin.install_failed");
    expect(r.json().error.details[0]).toMatchObject({
      step: "connectors",
      code: "connector.connect_failed",
      rolledBack: true,
    });
    // fake-tools-ui was enabled before and stays; fake-dep-provider enabled by this install is undone
    expect(await enabledPlugins()).toEqual(["fake-tools-ui"]);
    expect(await liveConnectors()).toHaveLength(0);
    expect(await liveSkills()).toHaveLength(0);
    const row = await env.db
      .selectFrom("plugin_installs")
      .select(["status", "error"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "failed",
      error: { step: "connectors", code: "connector.connect_failed" },
    });
    expect(await auditActions(env)).toContain("plugin.org_install_failed");
    const ok = await install(env.boss, env, appId, pluginBody());
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("members cannot install a plugin; uninstalling a missing install is 404", async () => {
    const appId = await seedPlugin(env);
    expect((await install(env.mem, env, appId, pluginBody())).statusCode).toBe(403);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/00000000-0000-4000-8000-000000000000`,
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe("plugin.install_not_found");
  });
});

describe("org plugin uninstall", { timeout: 60_000 }, () => {
  it("keeps the connector an agent uses and the connector extension a connector still uses, removes the rest", async () => {
    const a = await seedPlugin(env, { name: "fake-connector", extension: true });
    const b = await seedPlugin(env, { name: "notes", templates: false, skills: ["notes"] });
    // The install under test is what enables the connector extension here
    await env.db
      .deleteFrom("extension_org_configs")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "fake-connector")
      .execute();
    const ra = await install(env.boss, env, a, pluginBody());
    expect(ra.statusCode, ra.body).toBe(201);
    const rb = await install(env.boss, env, b);
    expect(rb.statusCode, rb.body).toBe(201);
    const [conn] = await liveConnectors();
    const agent = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "x",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "connector", connectorId: conn?.id, tools: "all" }]),
        },
        visibility: "org",
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);

    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${ra.json().installed.pluginInstallId}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    const report = del.json() as {
      removed: { kind: string; ref: string }[];
      kept: { kind: string; ref: string; reason: string }[];
    };
    // phase 2: skills are platform components; the plugin's goes off with it, nothing to remove
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual(
      expect.arrayContaining([
        { kind: "connector", ref: conn?.id, reason: "used_by_agents" },
        { kind: "extension", ref: "fake-connector", reason: "used_by_connectors" },
      ]),
    );
    expect(report.kept).toHaveLength(2);
    expect(await enabledPlugins(true)).toEqual(["fake-connector"]);
    expect(await usableNames()).toEqual(["platform:notes"]);
    expect(await liveConnectors()).toHaveLength(1);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.org_uninstalled")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ removed: report.removed });
    const list = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs`,
    });
    expect((list.json() as { installs: unknown[] }).installs).toHaveLength(1);
  });

  it("switching the plugin back on reuses the connector an earlier switch-off kept, instead of creating a second one", async () => {
    const a = await seedPlugin(env, { name: "fake-connector", extension: true });
    await env.db
      .deleteFrom("extension_org_configs")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "fake-connector")
      .execute();
    const ra = await install(env.boss, env, a, pluginBody());
    expect(ra.statusCode, ra.body).toBe(201);
    const [conn] = await liveConnectors();
    // an agent that leaves the connector on keeps it through the switch-off
    const agent = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "x",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const preview = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${a}/switch`,
      payload: { enabled: false },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const done = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${a}/switch`,
      payload: { enabled: false, confirm: (preview.json() as { confirm: string }).confirm },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await liveConnectors()).toHaveLength(1);
    // switching back on: the kept connector is taken back, not duplicated (its slug would clash)
    const on = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${a}/switch`,
      payload: { enabled: true, inputs: pluginBody() },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect((await liveConnectors()).map((c) => c.id)).toEqual([conn?.id]);
  });

  it("the item detail marks the template whose connector a switch-off kept (connected), and stops once that connector is deleted", async () => {
    const { itemId, connectorId } = await installConnectorPlugin();
    expect(await templateConnections(itemId)).toEqual([["gh", true]]);
    await switchOffKeepingConnector(itemId);
    // The kept connector is what the next install reuses: the wizard can skip the template's input
    expect(await templateConnections(itemId)).toEqual([["gh", true]]);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/connectors/${connectorId}`,
    });
    expect(del.statusCode, del.body).toBe(204);
    // Nothing is left to reuse: the template asks for input again
    expect(await templateConnections(itemId)).toEqual([["gh", false]]);
  });

  it("a reused connector deleted between plan and execute fails with catalog.connector_removed (not a silent install)", async () => {
    const { itemId, connectorId } = await installConnectorPlugin();
    await switchOffKeepingConnector(itemId);
    const installer = env.k.app.get(PluginInstaller);
    const plan = await installer.plan(
      env.orgId,
      env.bossId,
      itemId,
      "1.0.0",
      pluginBody(),
      "",
      undefined,
    );
    // The kept connector is reused, so the plan carries no input for the template
    expect(plan.connectors.size).toBe(0);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/connectors/${connectorId}`,
    });
    expect(del.statusCode, del.body).toBe(204);
    const failure = await installer
      .execute(env.orgId, env.bossId, plan, {}, { actions: planActions(plan) })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(InstallFailure);
    expect((failure as InstallFailure).cause).toMatchObject({ code: "catalog.connector_removed" });
    // The install is recorded failed, and no connector was silently skipped
    const row = await env.db
      .selectFrom("plugin_installs")
      .select(["status", "error"])
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "failed",
      error: { step: "connectors", code: "catalog.connector_removed" },
    });
    expect(await liveConnectors()).toHaveLength(0);
  });

  it("中途崩溃留下的 installing：未超时 409；超过 catalog.staleInstallMinutes 后经卸载回滚清理；failed 随时可清", async () => {
    const appId = await seedPlugin(env, {
      name: "fake-tools-ui",
      extension: true,
      templates: false,
    });
    const r = await install(env.boss, env, appId);
    const id = r.json().installed.pluginInstallId as string;
    // 模拟副本在安装中途崩溃：记录停在 installing
    await env.db
      .updateTable("plugin_installs")
      .set({ status: "installing" })
      .where("id", "=", id)
      .execute();
    const fresh = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${id}`,
    });
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json().error.code).toBe("plugin.install_in_progress");
    // 同一应用此时不能再装（未失败的安装还在）
    expect((await install(env.boss, env, appId)).json().error.code).toBe(
      "plugin.already_installed",
    );
    await env.db
      .updateTable("plugin_installs")
      .set({ installed_at: new Date(Date.now() - 31 * 60_000) })
      .where("id", "=", id)
      .execute();
    const stale = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${id}`,
    });
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json().removed).toEqual([{ kind: "extension", ref: "fake-tools-ui" }]);
    expect(await enabledPlugins()).toEqual([]);
    expect(await liveSkills()).toEqual([]);
    // 清理后可以重新安装；失败的安装记录随时可清
    const again = await install(env.boss, env, appId);
    expect(again.statusCode, again.body).toBe(201);
    await env.db
      .updateTable("plugin_installs")
      .set({ status: "failed" })
      .where("id", "=", again.json().installed.pluginInstallId)
      .execute();
    const failed = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${again.json().installed.pluginInstallId}`,
    });
    expect(failed.statusCode, failed.body).toBe(200);
    expect(await env.db.selectFrom("plugin_installs").select("id").execute()).toEqual([]);
  });

  it("cleaning up a failed install does not roll back twice: an extension re-enabled by hand stays", async () => {
    const appId = await seedPlugin(env, { name: "fake-tools-ui", extension: true, skills: [] });
    const failed = await install(env.boss, env, appId, pluginBody("wrong-token"));
    expect(failed.statusCode, failed.body).toBe(502);
    // 回滚成功的组件行已删掉
    const row = await env.db
      .selectFrom("plugin_installs")
      .select("id")
      .where("item_id", "=", appId)
      .executeTakeFirstOrThrow();
    expect(
      await env.db
        .selectFrom("plugin_install_components")
        .select("ref")
        .where("install_id", "=", row.id)
        .execute(),
    ).toEqual([]);
    // 之后：管理员手动重新启用 fake-tools-ui
    await enable("fake-tools-ui");
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${row.id}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ removed: [], kept: [] });
    expect(await enabledPlugins()).toEqual(["fake-tools-ui"]);
  });

  it("uninstalls a dependency's extension after the dependent's (reverse requires order); both were enabled dependencies first", async () => {
    await seedPlugin(env, { name: "dep-provider", extension: true, skills: [], templates: false });
    const p = await seedPlugin(env, {
      name: "dep-requirer",
      extension: true,
      skills: [],
      templates: false,
      dependencies: [{ name: "dep-provider", version: "^1.0.0" }],
    });
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(await enabledPlugins()).toEqual(["dep-provider", "dep-requirer"]);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${r.json().installed.pluginInstallId}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    const removed = (del.json() as UninstallBody).removed;
    expect(removed.map((x) => `${x.kind}:${x.kind === "plugin" ? "dep" : x.ref}`)).toEqual([
      "extension:dep-requirer",
      "extension:dep-provider",
      "plugin:dep",
    ]);
    expect(await enabledPlugins()).toEqual([]);
    expect(await liveInstalls()).toEqual([]);
  });
});

describe("org plugin install: the template's connector extension is an implied dependency", {
  timeout: 60_000,
}, () => {
  const offConnector = () =>
    env.db
      .deleteFrom("extension_org_configs")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "fake-connector")
      .execute();

  it("switches the provider on first, records it as a dependency, and an uninstall hands it back", async () => {
    await offConnector();
    await seedPlugin(env, {
      name: "fake-connector",
      extension: true,
      skills: [],
      templates: false,
    });
    const p = await seedPlugin(env, { name: "bridge", skills: [] });
    const r = await install(env.boss, env, p, pluginBody());
    expect(r.statusCode, r.body).toBe(201);
    expect(await enabledPlugins(true)).toEqual(["fake-connector"]);
    expect(await liveConnectors()).toHaveLength(1);
    const comps = r.json().install.components as { kind: string; ref: string }[];
    expect(comps.map((c) => c.kind)).toContain("plugin");
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${r.json().installed.pluginInstallId}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(await enabledPlugins(true)).toEqual([]);
    expect(await liveConnectors()).toHaveLength(0);
    expect(await liveInstalls()).toEqual([]);
  });

  it("a provider hidden from the org (disabled) or missing from the catalog: a clear 4xx, nothing written", async () => {
    await offConnector();
    const p = await seedPlugin(env, { name: "bridge", skills: [] });
    const missing = await install(env.boss, env, p, pluginBody());
    expect(missing.statusCode, missing.body).toBe(409);
    expect(missing.json().error.code).toBe("connector.kind_unavailable");
    expect(missing.body).toContain("fake-connector");
    await seedPlugin(env, {
      name: "fake-connector",
      extension: true,
      skills: [],
      templates: false,
      policy: "disabled",
    });
    const banned = await install(env.boss, env, p, pluginBody());
    expect(banned.statusCode, banned.body).toBe(409);
    expect(banned.json().error.code).toBe("connector.kind_unavailable");
    expect(await liveInstalls()).toEqual([]);
    expect(await liveConnectors()).toHaveLength(0);
    expect(await enabledPlugins(true)).toEqual([]);
  });
});

describe("org plugin install: implied providers, scope and state", { timeout: 60_000 }, () => {
  const offConnector = () =>
    env.db
      .deleteFrom("extension_org_configs")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "fake-connector")
      .execute();

  it("a named provider whose list excludes the org is not installed into it: 409, nothing written", async () => {
    await offConnector();
    const prov = await seedPlugin(env, {
      name: "fake-connector",
      extension: true,
      skills: [],
      templates: false,
    });
    await env.db
      .updateTable("catalog_items")
      .set({ scope: "named" })
      .where("id", "=", prov)
      .execute();
    const p = await seedPlugin(env, { name: "bridge", skills: [] });
    const r = await install(env.boss, env, p, pluginBody());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("connector.kind_unavailable");
    expect(await liveInstalls()).toEqual([]);
    expect(await liveConnectors()).toHaveLength(0);
    expect(await enabledPlugins(true)).toEqual([]);
  });

  it("a provider that is installed but switched off in the org: refused saying so", async () => {
    await offConnector();
    const prov = await seedPlugin(env, {
      name: "fake-connector",
      extension: true,
      skills: [],
      templates: false,
    });
    const first = await install(env.boss, env, prov);
    expect(first.statusCode, first.body).toBe(201);
    await offConnector();
    const p = await seedPlugin(env, { name: "bridge", skills: [] });
    const r = await install(env.boss, env, p, pluginBody());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("connector.kind_unavailable");
    expect(r.body).toContain("switched off");
    expect(await liveConnectors()).toHaveLength(0);
  });

  it("the item detail lists the implied provider among the dependencies", async () => {
    await offConnector();
    await seedPlugin(env, {
      name: "fake-connector",
      extension: true,
      skills: [],
      templates: false,
    });
    const p = await seedPlugin(env, { name: "bridge", skills: [] });
    const r = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog/${p}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().detail?.dependencies ?? r.json().dependencies).toEqual([
      { name: "fake-connector", range: "*", implied: true },
    ]);
  });
});

interface UninstallBody {
  removed: { kind: string; ref: string }[];
  kept: { kind: string; ref: string; reason: string }[];
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

const uninstallId = async (id: string) => {
  const r = await env.boss({
    method: "DELETE",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${id}`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as UninstallBody;
};

const installIdOf = async (name: string) =>
  (
    await env.db
      .selectFrom("plugin_installs as a")
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .select("a.id")
      .where("i.name", "=", name)
      .executeTakeFirstOrThrow()
  ).id;

/** A skills-only plugin (one skill named after it) with dependencies. */
const skillsPlugin = (
  name: string,
  dependencies?: { name: string; version: string }[],
  o: { version?: string; addTo?: string; policy?: "allow" | "needs_approval" | "disabled" } = {},
) =>
  seedPlugin(env, {
    name,
    templates: false,
    skills: [`${name}-skill`],
    ...(dependencies !== undefined && { dependencies }),
    ...o,
  });

describe("org plugin install: skill name conflicts (spec §9.2)", { timeout: 60_000 }, () => {
  const line = (skill: string, source: string) =>
    `Skill "${skill}" already exists in this org (source: ${source}). Remove or rename it, then install again.`;
  const snapshot = async () => ({
    skills: await env.db
      .selectFrom("skills")
      .select(["id", "name", "current_version", "catalog_item_id", "deleted_at"])
      .orderBy("name")
      .execute(),
    versions: await env.db.selectFrom("skill_versions").select(["skill_id", "version"]).execute(),
    installs: await env.db.selectFrom("plugin_installs").select(["id", "status"]).execute(),
    components: await env.db.selectFrom("plugin_install_components").select("ref").execute(),
    connectors: await liveConnectors(),
    enabled: await enabledPlugins(),
  });
  const ownSkill = (name: string) => {
    const md = new TextEncoder().encode(SKILL_MD(name));
    return env.k.app.get(SkillsService).createVersionFromFiles(env.orgId, env.bossId, {
      name,
      description: "Mine.",
      files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
    });
  };

  it("the org's own skill: 409 plugin.skill_conflict with one line per skill, nothing written", async () => {
    await ownSkill("pdf-tools");
    await ownSkill("notes");
    const appId = await seedPlugin(env, {
      name: "fake-tools-ui",
      extension: true,
      skills: ["pdf-tools", "fresh", "notes"],
    });
    const before = await snapshot();
    const r = await install(env.boss, env, appId, pluginBody());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toEqual({
      code: "plugin.skill_conflict",
      message: [
        line("pdf-tools", "the org's own skill"),
        line("notes", "the org's own skill"),
      ].join("\n"),
      details: [
        { skill: "pdf-tools", source: { kind: "org" } },
        { skill: "notes", source: { kind: "org" } },
      ],
    });
    expect(await snapshot()).toEqual(before);
  });

  it("another plugin's skill: the message names that plugin and its version; a disabled item is refused by the preflight", async () => {
    const alpha = await seedPlugin(env, { name: "alpha", templates: false, skills: ["shared"] });
    expect((await install(env.boss, env, alpha)).statusCode).toBe(201);
    const beta = await seedPlugin(env, {
      name: "beta",
      templates: false,
      skills: ["shared"],
      version: "3.1.0",
    });
    const before = await snapshot();
    const r = await install(env.boss, env, beta);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.message).toBe(line("shared", 'plugin "alpha" 1.0.0'));
    expect(r.json().error.details).toEqual([
      { skill: "shared", source: { kind: "plugin", name: "alpha", version: "1.0.0" } },
    ]);
    // disabled: refused before the preflight
    await setPolicy(env, beta, "disabled");
    const off = await install(env.boss, env, beta);
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json().error.code).toBe("plugin.disabled");
    expect(await snapshot()).toEqual(before);
  });

  it("two plugins of one install tree bringing the same skill: refused naming the dependency", async () => {
    await seedPlugin(env, { name: "dep", templates: false, skills: ["shared"] });
    const top = await seedPlugin(env, {
      name: "top",
      templates: false,
      skills: ["shared"],
      dependencies: [{ name: "dep", version: "^1.0.0" }],
    });
    const before = await snapshot();
    const r = await install(env.boss, env, top);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.message).toBe(line("shared", 'plugin "dep" 1.0.0'));
    expect(await snapshot()).toEqual(before);
  });

  it("an org copy of the same item (kept from an earlier install) is no conflict; the reinstall writes no skill row", async () => {
    const appId = await seedPlugin(env, { name: "notes", templates: false, skills: ["notes"] });
    const first = await install(env.boss, env, appId);
    expect(first.statusCode, first.body).toBe(201);
    await legacyCopies(env, env.orgId, appId);
    const [skill] = await liveSkills();
    await uninstallOf(first.json().installed.pluginInstallId);
    const again = await install(env.boss, env, appId);
    expect(again.statusCode, again.body).toBe(201);
    expect((await liveSkills()).map((s) => s.id)).toEqual([skill?.id]);
    expect(again.json().install.components).toEqual([]);
  });
});

describe("org plugin install: one kind per component", { timeout: 60_000 }, () => {
  it("a skills-only plugin turns its platform skill on in the org (no org row, no component)", async () => {
    const id = await skillsPlugin("notes");
    const r = await install(env.boss, env, id);
    expect(r.statusCode, r.body).toBe(201);
    expect(await liveSkills()).toEqual([]);
    expect(await usableNames()).toEqual(["platform:notes-skill"]);
    expect(r.json().install).toMatchObject({
      id: r.json().installed.pluginInstallId,
      itemId: id,
      status: "installed",
      components: [],
    });
  });

  it("a templates-only plugin needs the connector input: 400 before any install row, then 201 with it", async () => {
    const id = await seedPlugin(env, { name: "github", skills: [] });
    const bare = await install(env.boss, env, id);
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json().error.details).toEqual([
      expect.objectContaining({ path: "connectors.gh.credential" }),
    ]);
    // Bad template input is a 400 too (not a failed install)
    const bad = await install(env.boss, env, id, {
      connectors: { gh: { endpoint: { url: "not a url" }, credential: { token: MCP_TOKEN } } },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(JSON.stringify(bad.json().error.details)).toContain("connectors.gh.endpoint.url");
    const unknown = await install(env.boss, env, id, { connectors: { nope: {} } });
    expect(unknown.statusCode).toBe(400);
    const cfg = await install(env.boss, env, id, { ...pluginBody(), extensionConfig: {} });
    expect(cfg.statusCode).toBe(400);
    expect(cfg.json().error.details[0].path).toBe("extensionConfig");
    expect(await liveInstalls()).toEqual([]);
    const ok = await install(env.boss, env, id, pluginBody());
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveConnectors()).toHaveLength(1);
    expect(await enabledPlugins()).toEqual([]);
  });

  it("a personal static-auth template asks the installer for their own credential: 400 before any write, then 201 with it (final review I2)", async () => {
    const id = await seedPlugin(env, {
      name: "github",
      skills: [],
      templates: { gh: { auth: { type: "bearer", ownership: "personal" } } },
    });
    const bare = await install(env.boss, env, id, {
      connectors: { gh: { endpoint: { url: env.mcp.url } } },
    });
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json().error.details).toEqual([
      expect.objectContaining({
        path: "connectors.gh.credential",
        message: expect.stringContaining("each member's own credential"),
      }),
    ]);
    expect(await liveInstalls()).toEqual([]);
    expect(await liveConnectors()).toEqual([]);
    const ok = await install(env.boss, env, id, pluginBody());
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveConnectors()).toHaveLength(1);
  });

  it("a template whose connector extension is not deployed: the org list says not_deployed, install refuses it", async () => {
    const id = await seedPlugin(env, { name: "ghosted", skills: [], templatePlugin: "ghost" });
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    expect(
      (list.json().items as { id: string; notDeployed: boolean }[]).find((i) => i.id === id)
        ?.notDeployed,
    ).toBe(true);
    const r = await install(env.boss, env, id, pluginBody());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.not_deployed");
    expect(await liveInstalls()).toEqual([]);
  });

  it("an extension-only plugin enables its extension in the org (today's meaning of an org install)", async () => {
    const id = await seedPlugin(env, {
      name: "fake-dep-provider",
      extension: true,
      skills: [],
      templates: false,
    });
    const r = await install(env.boss, env, id);
    expect(r.statusCode, r.body).toBe(201);
    expect(await enabledPlugins()).toEqual(["fake-dep-provider"]);
    expect(r.json().install.components).toEqual([
      {
        kind: "extension",
        ref: "fake-dep-provider",
        created: true,
        skillVersion: null,
        dropped: false,
      },
    ]);
  });
});

describe("org plugin install: dependencies", { timeout: 60_000 }, () => {
  it("installs the dependency's platform version first (not a newer import), as a nested install recorded as a plugin component; uninstall removes it", async () => {
    const d = await skillsPlugin("dep");
    // imported ahead of updating: an import does not move the platform version (ruling P2-17)
    await skillsPlugin("dep", undefined, { version: "1.2.0", addTo: d });
    await skillsPlugin("dep", undefined, { version: "2.0.0", addTo: d });
    const p = await skillsPlugin("app", [{ name: "dep", version: "^1.0.0" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.0.0:installed"]);
    const depId = await installIdOf("dep");
    expect(r.json().install.components).toEqual(
      expect.arrayContaining([
        { kind: "plugin", ref: depId, created: true, skillVersion: null, dropped: false },
      ]),
    );
    expect(await usableNames()).toEqual(["platform:app-skill", "platform:dep-skill"]);
    const audits = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "plugin.org_installed")
      .where("target", "=", depId)
      .executeTakeFirstOrThrow();
    expect(audits.detail).toMatchObject({ dependencyOf: r.json().installed.pluginInstallId });
    // The org list shows both installed
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    const installed = (list.json().items as { name: string; installed: unknown }[]).map((i) => [
      i.name,
      i.installed !== null,
    ]);
    expect(installed).toEqual([
      ["app", true],
      ["dep", true],
    ]);
    const report = await uninstallId(r.json().installed.pluginInstallId);
    expect(report.kept).toEqual([]);
    expect(report.removed.map((x) => x.kind)).toEqual(["plugin"]);
    expect(await liveInstalls()).toEqual([]);
    expect(await usableNames()).toEqual([]);
  });

  it("a dependency whose platform version does not satisfy the range: 409 catalog.dependency_unresolved, even with a satisfying import (ruling P2-17)", async () => {
    const d = await skillsPlugin("dep");
    await skillsPlugin("dep", undefined, { version: "2.0.0", addTo: d });
    const p = await skillsPlugin("app", [{ name: "dep", version: "^2.0.0" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.dependency_unresolved");
    expect(r.json().error.message).toContain("dep@^2.0.0");
    expect(await liveInstalls()).toEqual([]);
  });

  it("a dependency without a platform version yet: the highest stable version satisfying the range, a prerelease only when no stable one does (ruling P2-17)", async () => {
    const d = await seedPlugin(env, {
      name: "dep",
      templates: false,
      skills: ["dep-skill"],
      platform: false,
    });
    await skillsPlugin("dep", undefined, { version: "1.4.0", addTo: d });
    await skillsPlugin("dep", undefined, { version: "1.5.0-rc.1", addTo: d });
    await skillsPlugin("dep", undefined, { version: "2.0.0-rc.1", addTo: d });
    const p = await skillsPlugin("app", [{ name: "dep", version: "^1.0.0" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.4.0:installed"]);
    await uninstallId(r.json().installed.pluginInstallId);
    const q = await skillsPlugin("next", [{ name: "dep", version: ">=2.0.0-rc.0" }]);
    const n = await install(env.boss, env, q);
    expect(n.statusCode, n.body).toBe(201);
    expect(await liveInstalls()).toContain("dep@2.0.0-rc.1:installed");
  });

  it("the org install takes no version: 400 validation_failed (one version per deployment, ruling P2-17)", async () => {
    const p = await skillsPlugin("app");
    await skillsPlugin("app", undefined, { version: "1.1.0", addTo: p });
    const r = await install(env.boss, env, p, { version: "1.1.0" });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
    const s = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/catalog/${p}/switch`,
      payload: { enabled: true, inputs: { version: "1.1.0" } },
    });
    expect(s.statusCode, s.body).toBe(400);
    expect(await liveInstalls()).toEqual([]);
    const ok = await install(env.boss, env, p);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed"]);
  });

  it("a range nothing in the catalog satisfies, or a dependency not in the catalog: 409 catalog.dependency_unresolved naming it, nothing written (no request either)", async () => {
    await skillsPlugin("dep", undefined, { version: "2.0.0" });
    const p = await skillsPlugin("app", [{ name: "dep", version: "^1.0.0" }], {
      policy: "needs_approval",
    });
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.dependency_unresolved");
    expect(r.json().error.message).toContain("dep@^1.0.0");
    const q = await skillsPlugin("other", [{ name: "missing", version: "*" }]);
    const m = await install(env.boss, env, q);
    expect(m.json().error.code).toBe("catalog.dependency_unresolved");
    expect(m.json().error.message).toContain("missing@*");
    expect(await liveInstalls()).toEqual([]);
    expect(await env.db.selectFrom("catalog_requests").select("id").execute()).toEqual([]);
    expect(await liveSkills()).toEqual([]);
  });

  it("a disabled dependency (anywhere in the tree): 409 catalog.dependency_disabled naming it", async () => {
    await skillsPlugin("leaf", undefined, { policy: "disabled" });
    await skillsPlugin("mid", [{ name: "leaf", version: "^1.0.0" }]);
    const p = await skillsPlugin("app", [{ name: "mid", version: "^1.0.0" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.dependency_disabled");
    expect(r.json().error.message).toContain("leaf");
    expect(await liveInstalls()).toEqual([]);
  });

  it("a cycle (a -> b -> a) and nesting deeper than 10 levels: 409 catalog.dependency_cycle", async () => {
    const a = await skillsPlugin("a", [{ name: "b", version: "^1.0.0" }]);
    await skillsPlugin("b", [{ name: "a", version: "^1.0.0" }]);
    const r = await install(env.boss, env, a);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.dependency_cycle");
    expect(r.json().error.message).toContain("a -> b -> a");
    // A chain c0 -> c1 -> ... -> c11 (11 levels below c0)
    for (let i = 1; i <= 11; i++) {
      await skillsPlugin(`c${i}`, i < 11 ? [{ name: `c${i + 1}`, version: "*" }] : undefined);
    }
    const c0 = await skillsPlugin("c0", [{ name: "c1", version: "*" }]);
    const deep = await install(env.boss, env, c0);
    expect(deep.json().error.code).toBe("catalog.dependency_cycle");
    expect(deep.json().error.message).toContain("10 levels");
    // Exactly ten levels are fine: c1 -> c2 -> ... -> c11
    const c1 = (
      await env.db
        .selectFrom("catalog_items")
        .select("id")
        .where("name", "=", "c1")
        .executeTakeFirstOrThrow()
    ).id;
    const ok = await install(env.boss, env, c1);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveInstalls()).toHaveLength(11);
  });

  it("a dependency already installed in the org is recorded created=false, not reinstalled, and kept (pre_existing) on uninstall", async () => {
    const d = await skillsPlugin("dep");
    const first = await install(env.boss, env, d);
    expect(first.statusCode, first.body).toBe(201);
    const depId = first.json().installed.pluginInstallId as string;
    const p = await skillsPlugin("app", [{ name: "dep", version: "^1.0.0" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().install.components).toEqual(
      expect.arrayContaining([
        { kind: "plugin", ref: depId, created: false, skillVersion: null, dropped: false },
      ]),
    );
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.0.0:installed"]);
    const report = await uninstallId(r.json().installed.pluginInstallId);
    expect(report.kept).toEqual([{ kind: "plugin", ref: depId, reason: "pre_existing" }]);
    expect(await liveInstalls()).toEqual(["dep@1.0.0:installed"]);
    expect(await usableNames()).toEqual(["platform:dep-skill"]);
    // A platform version outside the range: refused (the super admin updates the dependency first)
    const q = await skillsPlugin("strict", [{ name: "dep", version: "^2.0.0" }]);
    await skillsPlugin("dep", undefined, { version: "2.0.0", addTo: d });
    const platform = await install(env.boss, env, q);
    expect(platform.json().error.code).toBe("catalog.dependency_unresolved");
    expect(platform.json().error.message).toContain("platform version 1.0.0");
    // Installed at a version outside the range (the platform moved without this install): refused
    await env.db
      .updateTable("catalog_items")
      .set({ platform_synced_version: "2.0.0" })
      .where("id", "=", d)
      .execute();
    const strict = await install(env.boss, env, q);
    expect(strict.json().error.code).toBe("catalog.dependency_unresolved");
    expect(strict.json().error.message).toContain("1.0.0 installed");
  });

  it("uninstalling a dependency another install still uses keeps it (used_by_other_install); a dependency two installs share passes to the other one", async () => {
    await skillsPlugin("dep");
    const p = await skillsPlugin("app", [{ name: "dep", version: "^1.0.0" }]);
    const q = await skillsPlugin("app2", [{ name: "dep", version: "^1.0.0" }]);
    const rp = await install(env.boss, env, p);
    expect(rp.statusCode, rp.body).toBe(201);
    const rq = await install(env.boss, env, q);
    expect(rq.statusCode, rq.body).toBe(201);
    const depId = await installIdOf("dep");
    // Directly: kept, nothing removed
    const direct = await uninstallId(depId);
    expect(direct).toEqual({
      removed: [],
      kept: [{ kind: "plugin", ref: depId, reason: "used_by_other_install" }],
    });
    expect(await liveInstalls()).toHaveLength(3);
    // Through the install that created it: handed over to app2
    const first = await uninstallId(rp.json().installed.pluginInstallId);
    expect(first.kept).toEqual([{ kind: "plugin", ref: depId, reason: "used_by_other_install" }]);
    expect(await liveInstalls()).toEqual(["app2@1.0.0:installed", "dep@1.0.0:installed"]);
    const second = await uninstallId(rq.json().installed.pluginInstallId);
    expect(second.kept).toEqual([]);
    expect(second.removed).toEqual(expect.arrayContaining([{ kind: "plugin", ref: depId }]));
    expect(await liveInstalls()).toEqual([]);
    expect(await liveSkills()).toEqual([]);
  });

  it("a dependency two levels down shared with a direct dependency is installed once and removed with the root", async () => {
    await skillsPlugin("base");
    await skillsPlugin("mid", [{ name: "base", version: "*" }]);
    const p = await skillsPlugin("app", [
      { name: "mid", version: "*" },
      { name: "base", version: "*" },
    ]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(await liveInstalls()).toEqual([
      "app@1.0.0:installed",
      "base@1.0.0:installed",
      "mid@1.0.0:installed",
    ]);
    const report = await uninstallId(r.json().installed.pluginInstallId);
    expect(report.kept).toEqual([]);
    expect(await liveInstalls()).toEqual([]);
    expect(await liveSkills()).toEqual([]);
  });

  it("a failed step rolls back the dependency installs this install created; a dependency failing reports its step and name", async () => {
    await skillsPlugin("dep");
    const p = await seedPlugin(env, {
      name: "app",
      skills: [],
      dependencies: [{ name: "dep", version: "*" }],
    });
    const r = await install(env.boss, env, p, pluginBody("wrong-token"));
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.details[0]).toMatchObject({
      step: "connectors",
      code: "connector.connect_failed",
      rolledBack: true,
    });
    expect(await liveInstalls()).toEqual(["app@1.0.0:failed"]);
    expect(await liveSkills()).toEqual([]);
    // A dependency whose own step fails (enabling its extension)
    await seedPlugin(env, {
      name: "fake-dep-provider",
      extension: true,
      templates: false,
      skills: [],
    });
    const top = await skillsPlugin("top", [
      { name: "dep", version: "*" },
      { name: "fake-dep-provider", version: "*" },
    ]);
    const installer = env.k.app.get(PluginInstaller);
    const real = installer.enableExtension.bind(installer);
    const spy = vi.spyOn(installer, "enableExtension").mockImplementation(async (...a) => {
      if (a[1] === "fake-dep-provider") throw new ApiError("internal", "boom");
      return real(...a);
    });
    const f = await install(env.boss, env, top);
    spy.mockRestore();
    expect(f.statusCode, f.body).toBe(502);
    expect(f.json().error.details[0]).toMatchObject({
      step: "extension",
      dependency: "fake-dep-provider",
      rolledBack: true,
    });
    // dep (installed by this attempt) is gone again; the failed rows stay until cleared
    expect(await liveInstalls()).toEqual([
      "app@1.0.0:failed",
      "fake-dep-provider@1.0.0:failed",
      "top@1.0.0:failed",
    ]);
    expect(await liveSkills()).toEqual([]);
  });

  it("a dependency's template needing a credential: 400 naming the dependency before anything is written", async () => {
    await seedPlugin(env, { name: "github", skills: [] });
    const p = await skillsPlugin("app", [{ name: "github", version: "*" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.details[0].path).toBe("dependencies.github.connectors.gh.credential");
    expect(await liveInstalls()).toEqual([]);
  });

  it("dependencies: a disabled dependency refuses the install, enabling it lets the plugin and its dependencies install", async () => {
    await skillsPlugin("free");
    const gated = await skillsPlugin("gated");
    await setPolicy(env, gated, "disabled");
    const p = await skillsPlugin("app", [
      { name: "free", version: "*" },
      { name: "gated", version: "*" },
    ]);
    const off = await install(env.boss, env, p);
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json().error.code).toBe("catalog.dependency_disabled");
    expect(await liveInstalls()).toEqual([]);
    await setPolicy(env, gated, "allow");
    const ok = await install(env.boss, env, p);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveInstalls()).toEqual([
      "app@1.0.0:installed",
      "free@1.0.0:installed",
      "gated@1.0.0:installed",
    ]);
  });
});

// The private steps the race tests hook into (same module instance as the kernel under test)
type Hooked = {
  findLiveDependency: (...args: unknown[]) => Promise<unknown>;
  plan: (...args: unknown[]) => Promise<unknown>;
};
const proto = PluginInstaller.prototype as unknown as Hooked;

describe("org plugin install: dependency races", { timeout: 60_000 }, () => {
  it("an uninstall of a pre-existing dependency between the check and the record waits for the install and then keeps it", async () => {
    const d = await skillsPlugin("dep");
    const first = await install(env.boss, env, d);
    expect(first.statusCode, first.body).toBe(201);
    const depId = first.json().installed.pluginInstallId as string;
    const p = await skillsPlugin("app", [{ name: "dep", version: "*" }]);
    const original = proto.findLiveDependency;
    let del: ReturnType<typeof env.boss> | undefined;
    vi.spyOn(proto, "findLiveDependency").mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      const found = await original.apply(this, args);
      if (args[3] === true && del === undefined) {
        // Inside the record transaction (org row locked): the uninstall starts and must wait (a
        // request of its own: outside this transaction's context, as a real concurrent request)
        del = runOutsideTransaction(() =>
          env.boss({
            method: "DELETE",
            url: `/api/v1/orgs/${env.orgId}/plugin-installs/${depId}`,
          }),
        );
        await new Promise((r) => setTimeout(r, 300));
      }
      return found;
    });
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(del).toBeDefined();
    const d2 = await (del as ReturnType<typeof env.boss>);
    expect(d2.statusCode, d2.body).toBe(200);
    expect(d2.json()).toEqual({
      removed: [],
      kept: [{ kind: "plugin", ref: depId, reason: "used_by_other_install" }],
    });
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.0.0:installed"]);
    expect(r.json().install.components).toContainEqual({
      kind: "plugin",
      ref: depId,
      created: false,
      skillVersion: null,
      dropped: false,
    });
  });

  it("another install created the dependency meanwhile: plugin.already_installed is re-checked and recorded created=false", async () => {
    const d = await skillsPlugin("dep");
    const first = await install(env.boss, env, d);
    const depId = first.json().installed.pluginInstallId as string;
    const p = await skillsPlugin("app", [{ name: "dep", version: "*" }]);
    // The plan and the first record check both miss it (as if it was being created concurrently)
    vi.spyOn(proto, "findLiveDependency")
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => undefined);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().install.components).toContainEqual({
      kind: "plugin",
      ref: depId,
      created: false,
      skillVersion: null,
      dropped: false,
    });
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.0.0:installed"]);
  });

  it("a dependency another install is still installing: 409 plugin.install_in_progress, nothing recorded on it", async () => {
    const d = await skillsPlugin("dep");
    const first = await install(env.boss, env, d);
    await env.db
      .updateTable("plugin_installs")
      .set({ status: "installing" })
      .where("id", "=", first.json().installed.pluginInstallId)
      .execute();
    const p = await skillsPlugin("app", [{ name: "dep", version: "*" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("plugin.install_in_progress");
    expect(
      await env.db
        .selectFrom("plugin_install_components")
        .select("ref")
        .where("kind", "=", "plugin")
        .execute(),
    ).toEqual([]);
  });

  it("a dependency disabled between the plan and the install: the install fails with catalog.dependency_disabled", async () => {
    const d = await skillsPlugin("dep");
    const p = await skillsPlugin("app", [{ name: "dep", version: "*" }]);
    const original = proto.plan;
    vi.spyOn(proto, "plan").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const out = await original.apply(this, args);
      if (args[2] === p && args[4] !== null) {
        await env.db
          .updateTable("catalog_items")
          .set({ disabled: true })
          .where("id", "=", d)
          .execute();
      }
      return out;
    });
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.details[0]).toMatchObject({
      code: "catalog.dependency_disabled",
      dependency: "dep",
      rolledBack: true,
    });
    expect(await liveSkills()).toEqual([]);
  });
});
