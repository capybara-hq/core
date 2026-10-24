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

describe("应用的组织安装", { timeout: 60_000 }, () => {
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

describe("应用卸载", { timeout: 60_000 }, () => {
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

    // 卸载 a 时 todo 的所有权交给了 b：卸载 b 时照常移除，b 的技能也移除
    const delB = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/${rb.json().installed.appInstallId}`,
    });
    expect(delB.json().kept).toEqual([]);
    expect(delB.json().removed).toEqual(expect.arrayContaining([{ kind: "plugin", ref: "todo" }]));
    expect(delB.json().removed).toHaveLength(2);
    expect(await liveSkills()).toEqual([]);
    expect(await enabledPlugins()).toEqual(["connector-mcp", "example-counter"]);
  });

  for (const order of [
    ["a", "b"],
    ["b", "a"],
  ] as const) {
    it(`共用的插件与技能：按 ${order.join(" → ")} 卸载，最终状态一致（都移除，用着时不删，无遗留）`, async () => {
      const ids = {
        a: await seedApp(env, {
          name: "alpha",
          templates: false,
          plugins: ["todo"],
          skills: ["shared"],
        }),
        b: await seedApp(env, {
          name: "beta",
          templates: false,
          plugins: ["todo"],
          skills: ["shared"],
        }),
      };
      const installs: Record<string, string> = {};
      for (const k of ["a", "b"] as const) {
        const r = await install(env.boss, env, ids[k]);
        expect(r.statusCode, r.body).toBe(201);
        installs[k] = r.json().installed.appInstallId as string;
      }
      const [skill] = await liveSkills();
      expect((await liveSkills()).length).toBe(1);
      const del = async (k: "a" | "b") => {
        const r = await env.boss({
          method: "DELETE",
          url: `/api/v1/orgs/${env.orgId}/app-installs/${installs[k]}`,
        });
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as {
          removed: unknown[];
          kept: { kind: string; ref: string; reason: string }[];
        };
      };
      const first = await del(order[0]);
      // 另一个安装还在用：都保留，插件仍启用、技能仍在
      expect(first.removed).toEqual([]);
      expect(await enabledPlugins()).toEqual(["todo"]);
      expect((await liveSkills()).map((s) => s.id)).toEqual([skill?.id]);
      const second = await del(order[1]);
      expect(second.kept).toEqual([]);
      expect(second.removed).toEqual(
        expect.arrayContaining([
          { kind: "plugin", ref: "todo" },
          { kind: "skill", ref: skill?.id },
        ]),
      );
      expect(await enabledPlugins()).toEqual([]);
      expect(await liveSkills()).toEqual([]);
      expect(await env.db.selectFrom("app_installs").select("id").execute()).toEqual([]);
    });
  }

  it("中途崩溃留下的 installing：未超时 409；超过 directory.staleInstallMinutes 后经卸载回滚清理；failed 随时可清", async () => {
    const appId = await seedApp(env, { templates: false, plugins: ["todo"] });
    const r = await install(env.boss, env, appId);
    const id = r.json().installed.appInstallId as string;
    // 模拟副本在安装中途崩溃：记录停在 installing
    await env.db
      .updateTable("app_installs")
      .set({ status: "installing" })
      .where("id", "=", id)
      .execute();
    const fresh = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/${id}`,
    });
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json().error.code).toBe("app.install_in_progress");
    // 同一应用此时不能再装（未失败的安装还在）
    expect((await install(env.boss, env, appId)).json().error.code).toBe("app.already_installed");
    await env.db
      .updateTable("app_installs")
      .set({ installed_at: new Date(Date.now() - 31 * 60_000) })
      .where("id", "=", id)
      .execute();
    const stale = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/${id}`,
    });
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json().removed).toHaveLength(2);
    expect(await enabledPlugins()).toEqual([]);
    expect(await liveSkills()).toEqual([]);
    // 清理后可以重新安装；失败的安装记录随时可清
    const again = await install(env.boss, env, appId);
    expect(again.statusCode, again.body).toBe(201);
    await env.db
      .updateTable("app_installs")
      .set({ status: "failed" })
      .where("id", "=", again.json().installed.appInstallId)
      .execute();
    const failed = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/${again.json().installed.appInstallId}`,
    });
    expect(failed.statusCode, failed.body).toBe(200);
    expect(await env.db.selectFrom("app_installs").select("id").execute()).toEqual([]);
  });

  it("清理 failed 安装不重复回滚：之后手动重新启用的插件、新传的技能版本都不动", async () => {
    const base = await seedApp(env, {
      name: "base",
      templates: false,
      plugins: [],
      skills: ["pdf-tools"],
    });
    expect((await install(env.boss, env, base)).statusCode).toBe(201);
    const appId = await seedApp(env, {
      templates: false,
      plugins: ["todo"],
      skills: ["pdf-tools", "broken"],
    });
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
    const failed = await install(env.boss, env, appId);
    expect(failed.statusCode, failed.body).toBe(502);
    // 回滚成功的组件行已删掉
    const row = await env.db
      .selectFrom("app_installs")
      .select("id")
      .where("item_id", "=", appId)
      .executeTakeFirstOrThrow();
    expect(
      await env.db
        .selectFrom("app_install_components")
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
      url: `/api/v1/orgs/${env.orgId}/app-installs/${row.id}`,
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

  it("卸载按 requires 逆序处理插件：依赖方先移除，提供方随后移除，不留无主的提供方", async () => {
    // 清单里依赖方在前；安装按 requires 排序先启用提供方
    const appId = await seedApp(env, {
      templates: false,
      plugins: ["dep-requirer", "dep-provider"],
      skills: [],
    });
    const r = await install(env.boss, env, appId);
    expect(r.statusCode, r.body).toBe(201);
    expect(await enabledPlugins()).toEqual(["dep-provider", "dep-requirer"]);
    const del = await env.boss({
      method: "DELETE",
      url: `/api/v1/orgs/${env.orgId}/app-installs/${r.json().installed.appInstallId}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({
      removed: [
        { kind: "plugin", ref: "dep-requirer" },
        { kind: "plugin", ref: "dep-provider" },
      ],
      kept: [],
    });
    expect(await enabledPlugins()).toEqual([]);
  });
});
