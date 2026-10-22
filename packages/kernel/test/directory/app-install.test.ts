import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditActions,
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgDirectory,
  seedApp,
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
  await resetOrgDirectory(env);
  await env.db.deleteFrom("agent_versions").execute();
  await env.db.deleteFrom("agents").execute();
});

const appBody = (token = MCP_TOKEN) => ({
  app: {
    connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token } } },
  },
});

async function enabledPlugins(): Promise<string[]> {
  const rows = await env.db
    .selectFrom("plugin_org_configs")
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
    url: `/api/v1/orgs/${env.orgId}/plugins/${plugin}`,
    payload: { enabled: true },
  });
  expect(r.statusCode, r.body).toBe(200);
}

describe("应用的组织安装", () => {
  it("启用插件、按模板建连接器（凭据在 secrets、默认策略生效）、导入技能，组件逐个记录", async () => {
    const appId = await seedApp(env);
    const r = await install(env.boss, env, appId, appBody());
    expect(r.statusCode, r.body).toBe(201);
    const installId = r.json().installed.appInstallId as string;
    expect(await enabledPlugins()).toEqual(["example-counter", "todo"]);
    const [c] = await env.db
      .selectFrom("connectors")
      .select(["id", "directory_item_id", "directory_version", "slug"])
      .where("deleted_at", "is", null)
      .execute();
    expect(c).toMatchObject({
      directory_item_id: appId,
      directory_version: "1.0.0",
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
      .select(["name", "directory_item_id"])
      .where("deleted_at", "is", null)
      .execute();
    expect(skills).toEqual([{ name: "pdf-tools", directory_item_id: appId }]);
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/app-installs` });
    const [view] = (
      list.json() as { installs: { id: string; status: string; components: unknown[] }[] }
    ).installs;
    expect(view).toMatchObject({ id: installId, status: "installed" });
    expect(view?.components).toHaveLength(4);
    expect(await auditActions(env)).toContain("app.installed");
    // 同一应用不能再装
    const again = await install(env.boss, env, appId, appBody());
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("app.already_installed");
  });

  it("建连接器那一步失败：已启用的插件被撤销，安装记 failed（只含步骤与错误码），可以重装", async () => {
    await enable("todo");
    const appId = await seedApp(env);
    const r = await install(env.boss, env, appId, appBody("wrong-token"));
    expect(r.statusCode, r.body).toBe(502);
    expect(r.json().error.code).toBe("app.install_failed");
    expect(r.json().error.details[0]).toMatchObject({
      step: "connectors",
      code: "connector.connect_failed",
      rolledBack: true,
    });
    // 原本就启用的 todo 保留；本次启用的 example-counter 被撤销
    expect(await enabledPlugins()).toEqual(["todo"]);
    expect(await liveConnectors()).toHaveLength(0);
    expect(await liveSkills()).toHaveLength(0);
    const row = await env.db
      .selectFrom("app_installs")
      .select(["status", "error"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "failed",
      error: { step: "connectors", code: "connector.connect_failed" },
    });
    expect(await auditActions(env)).toContain("app.install_failed");
    const ok = await install(env.boss, env, appId, appBody());
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("导入技能那一步失败：已导入的技能、建好的连接器、启用的插件、已有技能新增的版本都被撤销", async () => {
    const appId = await seedApp(env, { skills: ["pdf-tools", "broken"] });
    // 已有同名组织技能 pdf-tools：应用安装给它加版本，回滚时退回
    const first = await seedApp(env, {
      name: "base",
      templates: false,
      plugins: [],
      skills: ["pdf-tools"],
    });
    expect((await install(env.boss, env, first)).statusCode).toBe(201);
    // 弄坏第二个技能的存储对象：读回时 sha256 不符
    const v = await env.db
      .selectFrom("directory_item_versions")
      .select("object_prefix")
      .where("item_id", "=", appId)
      .executeTakeFirstOrThrow();
    await env.k.storage
      .deployment()
      .put(`${v.object_prefix}skills/broken/SKILL.md`, new TextEncoder().encode("tampered"), {
        contentType: "application/octet-stream",
        size: 8,
      });
    const r = await install(env.boss, env, appId, appBody());
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

  it("成员不能装应用；不存在的安装卸载 404", async () => {
    const appId = await seedApp(env);
    expect((await install(env.mem, env, appId, appBody())).statusCode).toBe(403);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/00000000-0000-4000-8000-000000000000`,
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe("app.install_not_found");
  });
});

describe("应用卸载", () => {
  it("之前就有的插件、被 agent 引用的连接器、另一个应用也用的插件、仍有连接器在用的连接器插件都保留，其余移除", async () => {
    await enable("example-counter");
    const a = await seedApp(env, { plugins: ["todo", "example-counter", "connector-mcp"] });
    const b = await seedApp(env, {
      name: "notes",
      templates: false,
      plugins: ["todo"],
      skills: ["notes"],
    });
    const ra = await install(env.boss, env, a, appBody());
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
      url: `/api/v1/orgs/${env.orgId}/app-installs/${ra.json().installed.appInstallId}`,
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
        { kind: "plugin", ref: "example-counter", reason: "pre_existing" },
        { kind: "plugin", ref: "todo", reason: "used_by_other_install" },
        { kind: "plugin", ref: "connector-mcp", reason: "used_by_connectors" },
      ]),
    );
    expect(report.kept).toHaveLength(4);
    expect(await enabledPlugins()).toEqual(["connector-mcp", "example-counter", "todo"]);
    expect((await liveSkills()).map((s) => s.name)).toEqual(["notes"]);
    expect(await liveConnectors()).toHaveLength(1);
    const audit = await env.db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "app.uninstalled")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ removed: report.removed });
    const list = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/app-installs` });
    expect((list.json() as { installs: unknown[] }).installs).toHaveLength(1);

    // 卸载 b：todo 是 a 启用的（对 b 来说之前就有）→ 保留；b 的技能移除
    const delB = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/${rb.json().installed.appInstallId}`,
    });
    expect(delB.json().kept).toEqual([{ kind: "plugin", ref: "todo", reason: "pre_existing" }]);
    expect(delB.json().removed).toHaveLength(1);
    expect(await liveSkills()).toEqual([]);
  });
});
