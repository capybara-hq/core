import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditActions,
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgCatalog,
  seedPlugin,
  startOrgEnv,
} from "./org-env.js";

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
});

const pluginBody = (token = MCP_TOKEN) => ({
  connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token } } },
});

async function enabledPlugins(): Promise<string[]> {
  const rows = await env.db
    .selectFrom("extension_org_configs")
    .select("plugin")
    .where("org_id", "=", env.orgId)
    .where("enabled", "=", true)
    .orderBy("plugin")
    .execute();
  return rows.map((r) => r.plugin);
}

const liveConnectors = () =>
  env.db.selectFrom("connectors").select("id").where("deleted_at", "is", null).execute();
const liveSkills = () =>
  env.db.selectFrom("skills").select(["id", "name"]).where("deleted_at", "is", null).execute();

async function enable(plugin: string): Promise<void> {
  const r = await env.boss({
    method: "PUT",
    url: `/api/v1/orgs/${env.orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
}

describe("org plugin install", { timeout: 60_000 }, () => {
  it("enables the plugin's extension, creates the template's connector (credential in secrets, default policies), imports the skill, records each component", async () => {
    const appId = await seedPlugin(env, { name: "todo", extension: true });
    const r = await install(env.boss, env, appId, pluginBody());
    expect(r.statusCode, r.body).toBe(201);
    const installId = r.json().installed.pluginInstallId as string;
    expect(await enabledPlugins()).toEqual(["todo"]);
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
    const skills = await env.db
      .selectFrom("skills")
      .select(["name", "catalog_item_id"])
      .where("deleted_at", "is", null)
      .execute();
    expect(skills).toEqual([{ name: "pdf-tools", catalog_item_id: appId }]);
    const list = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs`,
    });
    const [view] = (
      list.json() as { installs: { id: string; status: string; components: unknown[] }[] }
    ).installs;
    expect(view).toMatchObject({ id: installId, status: "installed" });
    expect(view?.components).toHaveLength(3);
    expect(await auditActions(env)).toContain("plugin.org_installed");
    // 同一应用不能再装
    const again = await install(env.boss, env, appId, pluginBody());
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("plugin.already_installed");
  });

  it("the connector step fails: the extension it enabled is undone, the install is failed (step and code only), it can be installed again", async () => {
    await enable("todo");
    const appId = await seedPlugin(env, { name: "example-counter", extension: true });
    const r = await install(env.boss, env, appId, pluginBody("wrong-token"));
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.code).toBe("plugin.install_failed");
    expect(r.json().error.details[0]).toMatchObject({
      step: "connectors",
      code: "connector.connect_failed",
      rolledBack: true,
    });
    // todo was enabled before and stays; example-counter enabled by this install is undone
    expect(await enabledPlugins()).toEqual(["todo"]);
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

  it("导入技能那一步失败：已导入的技能、建好的连接器、启用的插件、已有技能新增的版本都被撤销", async () => {
    const appId = await seedPlugin(env, {
      name: "todo",
      extension: true,
      skills: ["pdf-tools", "broken"],
    });
    // An org skill pdf-tools exists: the install adds a version to it, the rollback reverts it
    const first = await seedPlugin(env, { name: "base", templates: false, skills: ["pdf-tools"] });
    expect((await install(env.boss, env, first)).statusCode).toBe(201);
    // 弄坏第二个技能的存储对象：读回时 sha256 不符
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select("object_prefix")
      .where("item_id", "=", appId)
      .executeTakeFirstOrThrow();
    await env.k.storage
      .deployment()
      .put(`${v.object_prefix}skills/broken/SKILL.md`, new TextEncoder().encode("tampered"), {
        contentType: "application/octet-stream",
        size: 8,
      });
    const r = await install(env.boss, env, appId, pluginBody());
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.details[0]).toMatchObject({ step: "skills", rolledBack: true });
    expect(await enabledPlugins()).toEqual([]);
    expect(await liveConnectors()).toHaveLength(0);
    const skills = await env.db
      .selectFrom("skills")
      .select(["name", "current_version"])
      .where("deleted_at", "is", null)
      .execute();
    expect(skills).toEqual([{ name: "pdf-tools", current_version: 1 }]);
    expect(await env.db.selectFrom("skill_versions").select("version").execute()).toHaveLength(1);
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
    const a = await seedPlugin(env, { name: "connector-mcp", extension: true });
    const b = await seedPlugin(env, { name: "notes", templates: false, skills: ["notes"] });
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
          tools: [{ kind: "connector", connectorId: conn?.id, tools: "all" }],
        },
        visibility: "org",
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const pdf = (await liveSkills()).find((s) => s.name === "pdf-tools");

    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${ra.json().installed.pluginInstallId}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    const report = del.json() as {
      removed: { kind: string; ref: string }[];
      kept: { kind: string; ref: string; reason: string }[];
    };
    expect(report.removed).toEqual([{ kind: "skill", ref: pdf?.id }]);
    expect(report.kept).toEqual(
      expect.arrayContaining([
        { kind: "connector", ref: conn?.id, reason: "used_by_agents" },
        { kind: "extension", ref: "connector-mcp", reason: "used_by_connectors" },
      ]),
    );
    expect(report.kept).toHaveLength(2);
    expect(await enabledPlugins()).toEqual(["connector-mcp"]);
    expect((await liveSkills()).map((s) => s.name)).toEqual(["notes"]);
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

  for (const order of [
    ["a", "b"],
    ["b", "a"],
  ] as const) {
    it(`a shared skill: uninstalled in the order ${order.join(" → ")}, the end state is the same (kept while used, then removed)`, async () => {
      const ids = {
        a: await seedPlugin(env, { name: "alpha", templates: false, skills: ["shared"] }),
        b: await seedPlugin(env, { name: "beta", templates: false, skills: ["shared"] }),
      };
      const installs: Record<string, string> = {};
      for (const k of ["a", "b"] as const) {
        const r = await install(env.boss, env, ids[k]);
        expect(r.statusCode, r.body).toBe(201);
        installs[k] = r.json().installed.pluginInstallId as string;
      }
      const [skill] = await liveSkills();
      expect((await liveSkills()).length).toBe(1);
      const del = async (k: "a" | "b") => {
        const r = await env.boss({
          method: "DELETE",
          url: `/api/v1/orgs/${env.orgId}/plugin-installs/${installs[k]}`,
        });
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as {
          removed: unknown[];
          kept: { kind: string; ref: string; reason: string }[];
        };
      };
      const first = await del(order[0]);
      // The other install still uses it: kept
      expect(first.removed).toEqual([]);
      expect((await liveSkills()).map((s) => s.id)).toEqual([skill?.id]);
      const second = await del(order[1]);
      expect(second.kept).toEqual([]);
      expect(second.removed).toEqual([{ kind: "skill", ref: skill?.id }]);
      expect(await liveSkills()).toEqual([]);
      expect(await env.db.selectFrom("plugin_installs").select("id").execute()).toEqual([]);
    });
  }

  it("中途崩溃留下的 installing：未超时 409；超过 catalog.staleInstallMinutes 后经卸载回滚清理；failed 随时可清", async () => {
    const appId = await seedPlugin(env, { name: "todo", extension: true, templates: false });
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
    expect(stale.json().removed).toHaveLength(2);
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

  it("清理 failed 安装不重复回滚：之后手动重新启用的插件、新传的技能版本都不动", async () => {
    const base = await seedPlugin(env, { name: "base", templates: false, skills: ["pdf-tools"] });
    expect((await install(env.boss, env, base)).statusCode).toBe(201);
    const appId = await seedPlugin(env, {
      name: "todo",
      extension: true,
      templates: false,
      skills: ["pdf-tools", "broken"],
    });
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select("object_prefix")
      .where("item_id", "=", appId)
      .executeTakeFirstOrThrow();
    await env.k.storage
      .deployment()
      .put(`${v.object_prefix}skills/broken/SKILL.md`, new TextEncoder().encode("tampered"), {
        contentType: "application/octet-stream",
        size: 8,
      });
    const failed = await install(env.boss, env, appId);
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
    // 之后：管理员手动重新启用 todo，用户给 pdf-tools 传了新版本（又是 v2）
    await enable("todo");
    const [skill] = await liveSkills();
    const md = new TextEncoder().encode(
      "---\nname: pdf-tools\ndescription: Mine.\n---\n# pdf-tools\n\nMine.\n",
    );
    const up = await env.k.skills.createVersionFromFiles(env.orgId, env.bossId, {
      name: "pdf-tools",
      description: "Mine.",
      files: [{ path: "SKILL.md", size: md.byteLength, sha256: "x".repeat(64), data: md }],
    });
    expect(up.version).toBe(2);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/plugin-installs/${row.id}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ removed: [], kept: [] });
    expect(await enabledPlugins()).toEqual(["todo"]);
    const after = await env.db
      .selectFrom("skills")
      .select(["id", "current_version", "description"])
      .where("deleted_at", "is", null)
      .execute();
    expect(after).toEqual([{ id: skill?.id, current_version: 2, description: "Mine." }]);
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

describe("org plugin install: one kind per component", { timeout: 60_000 }, () => {
  it("a skills-only plugin creates its skill with the plugin item as provenance", async () => {
    const id = await skillsPlugin("notes");
    const r = await install(env.boss, env, id);
    expect(r.statusCode, r.body).toBe(201);
    const skills = await env.db
      .selectFrom("skills")
      .select(["name", "catalog_item_id", "catalog_version"])
      .where("deleted_at", "is", null)
      .execute();
    expect(skills).toEqual([
      { name: "notes-skill", catalog_item_id: id, catalog_version: "1.0.0" },
    ]);
    expect(r.json().install).toMatchObject({
      id: r.json().installed.pluginInstallId,
      itemId: id,
      status: "installed",
      components: [{ kind: "skill", created: true }],
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

  it("a template whose connector extension is not deployed: the org list says not_deployed, install refuses it", async () => {
    const id = await seedPlugin(env, { name: "ghosted", skills: [], templatePlugin: "ghost" });
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
    expect(
      (list.json().items as { id: string; installable: string }[]).find((i) => i.id === id)
        ?.installable,
    ).toBe("not_deployed");
    const r = await install(env.boss, env, id, pluginBody());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe("catalog.not_deployed");
    expect(await liveInstalls()).toEqual([]);
  });

  it("an extension-only plugin enables its extension in the org (today's meaning of an org install)", async () => {
    const id = await seedPlugin(env, {
      name: "example-counter",
      extension: true,
      skills: [],
      templates: false,
    });
    const r = await install(env.boss, env, id);
    expect(r.statusCode, r.body).toBe(201);
    expect(await enabledPlugins()).toEqual(["example-counter"]);
    expect(r.json().install.components).toEqual([
      { kind: "extension", ref: "example-counter", created: true, skillVersion: null },
    ]);
  });
});

describe("org plugin install: dependencies", { timeout: 60_000 }, () => {
  it("installs the highest imported version satisfying the range first, as a nested install recorded as a plugin component; uninstall removes it", async () => {
    const d = await skillsPlugin("dep");
    await skillsPlugin("dep", undefined, { version: "1.2.0", addTo: d });
    await skillsPlugin("dep", undefined, { version: "2.0.0", addTo: d });
    const p = await skillsPlugin("app", [{ name: "dep", version: "^1.0.0" }]);
    const r = await install(env.boss, env, p);
    expect(r.statusCode, r.body).toBe(201);
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.2.0:installed"]);
    const depId = await installIdOf("dep");
    expect(r.json().install.components).toEqual(
      expect.arrayContaining([{ kind: "plugin", ref: depId, created: true, skillVersion: null }]),
    );
    const skills = await env.db
      .selectFrom("skills")
      .select(["name", "catalog_item_id", "catalog_version"])
      .where("deleted_at", "is", null)
      .orderBy("name")
      .execute();
    expect(skills).toEqual([
      { name: "app-skill", catalog_item_id: p, catalog_version: "1.0.0" },
      { name: "dep-skill", catalog_item_id: d, catalog_version: "1.2.0" },
    ]);
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
    expect(report.removed.map((x) => x.kind)).toEqual(["skill", "skill", "plugin"]);
    expect(await liveInstalls()).toEqual([]);
    expect(await liveSkills()).toEqual([]);
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
    // Ten levels are fine
    const c1 = (
      await env.db
        .selectFrom("catalog_items")
        .select("id")
        .where("name", "=", "c2")
        .executeTakeFirstOrThrow()
    ).id;
    const ok = await install(env.boss, env, c1);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveInstalls()).toHaveLength(10);
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
      expect.arrayContaining([{ kind: "plugin", ref: depId, created: false, skillVersion: null }]),
    );
    expect(await liveInstalls()).toEqual(["app@1.0.0:installed", "dep@1.0.0:installed"]);
    const report = await uninstallId(r.json().installed.pluginInstallId);
    expect(report.kept).toEqual([{ kind: "plugin", ref: depId, reason: "pre_existing" }]);
    expect(await liveInstalls()).toEqual(["dep@1.0.0:installed"]);
    expect((await liveSkills()).map((s) => s.name)).toEqual(["dep-skill"]);
    // Installed at a version outside the range: refused (org upgrades arrive in phase A)
    const q = await skillsPlugin("strict", [{ name: "dep", version: "^2.0.0" }]);
    await skillsPlugin("dep", undefined, { version: "2.0.0", addTo: d });
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
    // A dependency whose own step fails
    const broken = await seedPlugin(env, {
      name: "broken",
      templates: false,
      skills: ["broken"],
    });
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select("object_prefix")
      .where("item_id", "=", broken)
      .executeTakeFirstOrThrow();
    await env.k.storage
      .deployment()
      .put(`${v.object_prefix}skills/broken/SKILL.md`, new TextEncoder().encode("tampered"), {
        contentType: "application/octet-stream",
        size: 8,
      });
    const top = await skillsPlugin("top", [
      { name: "dep", version: "*" },
      { name: "broken", version: "*" },
    ]);
    const f = await install(env.boss, env, top);
    expect(f.statusCode, f.body).toBe(502);
    expect(f.json().error.details[0]).toMatchObject({
      step: "skills",
      dependency: "broken",
      rolledBack: true,
    });
    // dep (installed by this attempt) is gone again; the failed rows stay until cleared
    expect(await liveInstalls()).toEqual([
      "app@1.0.0:failed",
      "broken@1.0.0:failed",
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

  it("approval follows the installed plugin only: a needs_approval plugin with dependencies goes through one request", async () => {
    await skillsPlugin("free");
    await skillsPlugin("gated", undefined, { policy: "needs_approval" });
    const p = await skillsPlugin(
      "app",
      [
        { name: "free", version: "*" },
        { name: "gated", version: "*" },
      ],
      { policy: "needs_approval" },
    );
    const pend = await install(env.boss, env, p);
    expect(pend.statusCode, pend.body).toBe(202);
    const requests = await env.db
      .selectFrom("catalog_requests")
      .select(["id", "item_id"])
      .execute();
    expect(requests).toEqual([{ id: pend.json().request.id, item_id: p }]);
    const d = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/requests/${pend.json().request.id}/decide`,
      payload: { decision: "approve" },
    });
    expect(d.statusCode, d.body).toBe(200);
    const ok = await install(env.boss, env, p);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await liveInstalls()).toEqual([
      "app@1.0.0:installed",
      "free@1.0.0:installed",
      "gated@1.0.0:installed",
    ]);
    expect(await env.db.selectFrom("catalog_requests").select("id").execute()).toHaveLength(1);
    expect(await env.db.selectFrom("catalog_org_grants").select("item_id").execute()).toEqual([
      { item_id: p },
    ]);
  });
});
