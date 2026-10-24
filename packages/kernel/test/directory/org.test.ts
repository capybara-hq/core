import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  importDeployedPlugin,
  importSkill,
  importTemplate,
  install,
  MCP_TOKEN,
  type OrgEnv,
  requestItem,
  resetOrgDirectory,
  seedApp,
  seedPluginItem,
  setDeployment,
  setPolicy,
  startOrgEnv,
} from "./org-env.js";
import { mcpTemplate, templateTgz } from "./packages.js";

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgDirectory(env);
});

type Item = {
  id: string;
  installable: string;
  installed: Record<string, string> | null;
  request: { id: string; stage: string; status: string } | null;
};

async function orgList(req: OrgEnv["root"]): Promise<Item[]> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/directory` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: Item[] }).items;
}

async function grant(itemId: string): Promise<void> {
  const reqs = await env.root({ method: "GET", url: "/api/v1/admin/directory/requests" });
  const pending = (reqs.json() as { requests: { id: string; item: { id: string } }[] }).requests;
  const r = pending.find((x) => x.item.id === itemId);
  expect(r).toBeDefined();
  const d = await env.root({
    method: "POST",
    url: `/api/v1/admin/directory/requests/${r?.id}/decide`,
    payload: { decision: "approve" },
  });
  expect(d.statusCode, d.body).toBe(200);
}

const connectorBody = (over: Record<string, unknown> = {}) => ({
  connector: {
    name: "GitHub",
    endpoint: { url: env.mcp.url },
    credential: { token: MCP_TOKEN },
    ...over,
  },
});

describe("组织从目录安装：三档策略", { timeout: 60_000 }, () => {
  it("技能：allow 直接装；disabled 拒绝且成员看不到；needs_approval 经企业管理员批准后才能装", async () => {
    const itemId = await importSkill(env);
    // allow
    const ok = await install(env.boss, env, itemId);
    expect(ok.statusCode, ok.body).toBe(201);
    const skillId = (ok.json() as { installed: { skillId: string } }).installed.skillId;
    const row = await env.db
      .selectFrom("skills")
      .select(["directory_item_id", "directory_version", "name"])
      .where("id", "=", skillId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      directory_item_id: itemId,
      directory_version: "1.0.0",
      name: "pdf-tools",
    });
    expect(await auditActions(env)).toContain("directory.installed");
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toMatchObject({
      skillId,
      version: "1.0.0",
    });
    // 已装的不受 disabled 影响，但不能新装
    await setPolicy(env, itemId, "disabled");
    const off = await install(env.boss, env, itemId);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe("directory.item_disabled");
    expect(await orgList(env.mem)).toHaveLength(0);
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installable).toBe("disabled");
    expect(
      await env.db.selectFrom("skills").select("id").where("deleted_at", "is", null).execute(),
    ).toHaveLength(1);
    // needs_approval：202 建部署级申请，什么都没装
    await setPolicy(env, itemId, "needs_approval");
    const pend = await install(env.boss, env, itemId, { version: "1.0.0" });
    expect(pend.statusCode, pend.body).toBe(202);
    expect(pend.json().request).toMatchObject({ stage: "deployment", status: "pending" });
    expect((await orgList(env.mem)).find((i) => i.id === itemId)?.installable).toBe(
      "needs_approval",
    );
    const versionsBefore = await env.db.selectFrom("skill_versions").select("version").execute();
    expect(versionsBefore).toHaveLength(1);
    await grant(itemId);
    expect((await orgList(env.mem)).find((i) => i.id === itemId)?.installable).toBe("granted");
    const again = await install(env.boss, env, itemId);
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json() as { installed: { skillVersion: number } }).installed.skillVersion).toBe(
      2,
    );
  });

  it("连接器模板：按模板建连接器，凭据进 secrets、默认策略 template；disabled 403；needs_approval 202", async () => {
    const itemId = await importTemplate(env);
    const ok = await install(env.boss, env, itemId, connectorBody());
    expect(ok.statusCode, ok.body).toBe(201);
    const connectorId = (ok.json() as { installed: { connectorId: string } }).installed.connectorId;
    const c = await env.db
      .selectFrom("connectors")
      .select(["directory_item_id", "directory_version", "endpoint", "auth"])
      .where("id", "=", connectorId)
      .executeTakeFirstOrThrow();
    expect(c).toMatchObject({
      directory_item_id: itemId,
      directory_version: "1.0.0",
      endpoint: { url: env.mcp.url },
      auth: { type: "bearer", ownership: "org" },
    });
    const tools = await env.db
      .selectFrom("connector_tools")
      .select(["name", "default_policy", "policy_source"])
      .where("connector_id", "=", connectorId)
      .orderBy("name")
      .execute();
    expect(tools).toEqual([
      { name: "delete_all", default_policy: "ask", policy_source: "derived" },
      { name: "search", default_policy: "allow", policy_source: "template" },
    ]);
    const secrets = await env.db
      .selectFrom("secrets")
      .select("key")
      .where("org_id", "=", env.orgId)
      .execute();
    expect(secrets.some((s) => s.key.includes(connectorId))).toBe(true);

    await setPolicy(env, itemId, "disabled");
    const off = await install(env.boss, env, itemId, connectorBody({ slug: "gh2" }));
    expect(off.json().error.code).toBe("directory.item_disabled");
    await setPolicy(env, itemId, "needs_approval");
    const pend = await install(env.boss, env, itemId, connectorBody({ slug: "gh2" }));
    expect(pend.statusCode).toBe(202);
    await grant(itemId);
    const again = await install(env.boss, env, itemId, connectorBody({ slug: "gh2" }));
    expect(again.statusCode, again.body).toBe(201);
  });

  it("篡改模板里不可编辑的端点、夹带认证方式都无效：400，什么都没建", async () => {
    const itemId = await importTemplate(env);
    const bad = await install(
      env.boss,
      env,
      itemId,
      connectorBody({ endpoint: { url: env.mcp.url, headers: { "X-Tenant": "evil" } } }),
    );
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().error.details)).toContain("connector.endpoint.headers");
    const withAuth = await install(env.boss, env, itemId, {
      connector: { endpoint: { url: env.mcp.url }, auth: { type: "none" } },
    });
    expect(withAuth.statusCode).toBe(400);
    // 凭据样式的头也挡在合并后的端点上（模板只允许 url）
    const leak = await install(env.boss, env, itemId, {
      connector: { endpoint: { url: `https://user:pw@127.0.0.1/mcp` }, credential: { token: "x" } },
    });
    expect(leak.statusCode).toBe(400);
    expect(await env.db.selectFrom("connectors").select("id").execute()).toHaveLength(0);
  });

  it("OAuth 模板：组织安装时按部署的 OAuth 地址策略复核 tokenUrl（导入时只做了静态校验）", async () => {
    const itemId = await importTemplate(env, {
      name: "@acme/oauth-mcp",
      template: mcpTemplate({
        auth: { type: "oauth_client", ownership: "org", tokenUrl: "http://token.example.com/t" },
        defaultToolPolicies: {},
      }),
    });
    const r = await install(env.boss, env, itemId, {
      connector: { endpoint: { url: env.mcp.url }, client: { clientId: "c", clientSecret: "s" } },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(JSON.stringify(r.json().error.details)).toContain("auth.tokenUrl");
    // OAuth 模板只收 client，不收静态凭据
    const wrong = await install(env.boss, env, itemId, {
      connector: { endpoint: { url: env.mcp.url }, credential: { token: "x" } },
    });
    expect(wrong.statusCode).toBe(400);
    expect(await env.db.selectFrom("connectors").select("id").execute()).toHaveLength(0);
  });

  it("授权码模板：安装时没有快照，首个快照时按模板 defaultToolPolicies 设默认策略（policy_source template）", async () => {
    const itemId = await importTemplate(env, {
      name: "@acme/code-mcp",
      template: mcpTemplate({
        auth: {
          type: "oauth_code",
          ownership: "personal",
          discovery: "manual",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          client: "manual",
        },
      }),
    });
    const r = await install(env.boss, env, itemId, {
      connector: { endpoint: { url: env.mcp.url }, client: { clientId: "c" } },
    });
    expect(r.statusCode, r.body).toBe(201);
    const connectorId = r.json().installed.connectorId as string;
    expect(
      await env.db
        .selectFrom("connector_tools")
        .select("name")
        .where("connector_id", "=", connectorId)
        .execute(),
    ).toHaveLength(0);
    // 首个成员连接后（这里直接写入其个人 token）刷新：首个快照
    await env.k.tools.credentials.setOAuthTokens(
      env.orgId,
      connectorId,
      { kind: "user", accountId: env.bossId },
      { access_token: MCP_TOKEN, token_type: "bearer", expires_at: null },
    );
    const refreshed = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors/${connectorId}/refresh`,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const tools = await env.db
      .selectFrom("connector_tools")
      .select(["name", "default_policy", "policy_source"])
      .where("connector_id", "=", connectorId)
      .orderBy("name")
      .execute();
    expect(tools).toEqual([
      { name: "delete_all", default_policy: "ask", policy_source: "derived" },
      { name: "search", default_policy: "allow", policy_source: "template" },
    ]);
  });

  it("插件条目：在本组织启用受条目策略约束", async () => {
    const itemId = await seedPluginItem(env, "todo");
    const ok = await install(env.boss, env, itemId);
    expect(ok.statusCode, ok.body).toBe(201);
    const enabled = await env.db
      .selectFrom("plugin_org_configs")
      .select("enabled")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(enabled.enabled).toBe(true);
    // 停用后再装 = 新装，受策略约束
    await env.root({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/plugins/todo`,
      payload: { enabled: false },
    });
    await setPolicy(env, itemId, "disabled");
    expect((await install(env.boss, env, itemId)).json().error.code).toBe(
      "directory.item_disabled",
    );
    await setPolicy(env, itemId, "needs_approval");
    expect((await install(env.boss, env, itemId)).statusCode).toBe(202);
    await grant(itemId);
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    // 部署上没有的插件
    const ghost = await seedPluginItem(env, "ghost");
    expect((await orgList(env.boss)).find((i) => i.id === ghost)?.installable).toBe("not_deployed");
    const nd = await install(env.boss, env, ghost);
    expect(nd.statusCode).toBe(409);
    expect(nd.json().error.code).toBe("directory.not_deployed");
  });

  it("应用条目：三档策略对应用生效（应用里的插件按应用条目策略，不看插件条目的 needs_approval）", async () => {
    // 插件条目 needs_approval 且没授予：应用里的插件仍按应用条目策略启用
    await seedPluginItem(env, "todo", "needs_approval");
    const appId = await seedApp(env, { templates: false, plugins: ["todo"] });
    await setPolicy(env, appId, "disabled");
    expect((await install(env.boss, env, appId)).json().error.code).toBe("directory.item_disabled");
    await setPolicy(env, appId, "needs_approval");
    const pend = await install(env.boss, env, appId);
    expect(pend.statusCode).toBe(202);
    await grant(appId);
    const ok = await install(env.boss, env, appId);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().installed.appInstallId).toEqual(expect.any(String));
    expect((await orgList(env.boss)).find((i) => i.id === appId)?.installed).toMatchObject({
      appInstallId: ok.json().installed.appInstallId,
    });
    // 必选插件没装到部署
    const ghostApp = await seedApp(env, { name: "ghost", templates: false, plugins: ["ghost"] });
    const nd = await install(env.boss, env, ghostApp);
    expect(nd.json().error.code).toBe("directory.not_deployed");
  });

  it("插件条目 disabled 是总开关：含它的应用装不上（点名插件），已在本组织启用的不受影响（裁决 M-5）", async () => {
    const pluginItem = await seedPluginItem(env, "todo", "disabled");
    const appId = await seedApp(env, { templates: false, plugins: ["todo"], skills: [] });
    const r = await install(env.boss, env, appId);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.code).toBe("directory.item_disabled");
    expect(r.json().error.message).toContain("todo");
    expect(await env.db.selectFrom("app_installs").select("id").execute()).toEqual([]);
    // 直接启用同样不行（没有来源行也一样）
    const direct = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/plugins/todo`,
      payload: { enabled: true },
    });
    expect(direct.json().error.code).toBe("directory.item_disabled");
    // 已经启用的插件：应用照常装（插件记 created=false）
    await setPolicy(env, pluginItem, "allow");
    expect(
      (
        await env.boss({
          method: "PUT",
          url: `/api/v1/orgs/${env.orgId}/plugins/todo`,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    await setPolicy(env, pluginItem, "disabled");
    const ok = await install(env.boss, env, appId);
    expect(ok.statusCode, ok.body).toBe(201);
    const comps = await env.db
      .selectFrom("app_install_components")
      .select(["kind", "ref", "created"])
      .execute();
    expect(comps).toEqual([{ kind: "plugin", ref: "todo", created: false }]);
  });

  it("可选插件：没装到部署时列表可装，安装跳过它与用到它的模板并在结果里列出（M-3）", async () => {
    const appId = await seedApp(env, {
      plugins: ["todo", "ghost-connector"],
      optional: ["ghost-connector"],
      templatePlugin: "ghost-connector",
      skills: [],
    });
    expect((await orgList(env.boss)).find((i) => i.id === appId)?.installable).toBe("yes");
    const r = await install(env.boss, env, appId, { app: { connectors: {} } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().installed.skipped).toEqual({
      plugins: ["ghost-connector"],
      connectorTemplates: ["gh"],
    });
    expect(
      await env.db.selectFrom("connectors").select("id").where("deleted_at", "is", null).execute(),
    ).toEqual([]);
  });

  it("插件加载的版本不满足应用的范围：必选的 not_deployed（点名版本），可选的跳过（M-4）", async () => {
    const appId = await seedApp(env, {
      templates: false,
      plugins: ["todo"],
      ranges: { todo: "^2.0.0" },
      skills: [],
    });
    expect((await orgList(env.boss)).find((i) => i.id === appId)?.installable).toBe("not_deployed");
    const r = await install(env.boss, env, appId);
    expect(r.json().error.code).toBe("directory.not_deployed");
    expect(r.json().error.message).toContain("todo (deployed 0.1.0, the app needs ^2.0.0)");
    const opt = await seedApp(env, {
      name: "opt",
      templates: false,
      plugins: ["todo", "example-counter"],
      optional: ["todo"],
      ranges: { todo: "^2.0.0" },
      skills: [],
    });
    expect((await orgList(env.boss)).find((i) => i.id === opt)?.installable).toBe("yes");
    const ok = await install(env.boss, env, opt);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().installed.skipped).toEqual({ plugins: ["todo"], connectorTemplates: [] });
  });

  it("独立连接器模板的 pluginVersion：加载的连接器插件版本不满足 → not_deployed（M-11）", async () => {
    const tpl = await importTemplate(env);
    // 直接改存好的模板（导入时已按加载的版本复核过）
    const v = await env.db
      .selectFrom("directory_item_versions")
      .select("section")
      .where("item_id", "=", tpl)
      .executeTakeFirstOrThrow();
    const section = v.section as { template: Record<string, unknown> };
    section.template.pluginVersion = "^9.0.0";
    await env.db
      .updateTable("directory_item_versions")
      .set({ section: JSON.stringify(section) })
      .where("item_id", "=", tpl)
      .execute();
    expect((await orgList(env.boss)).find((i) => i.id === tpl)?.installable).toBe("not_deployed");
    const r = await install(env.boss, env, tpl, connectorBody());
    expect(r.json().error.code).toBe("directory.not_deployed");
    // 导入时同样复核
    const bad = await env.root({
      method: "POST",
      url: "/api/v1/admin/directory/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(
        await templateTgz({
          name: "@acme/other",
          template: mcpTemplate({ pluginVersion: "^9.0.0" }),
        }),
      ),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("pluginVersion");
  });
});

describe("直接启用来自目录的插件（C22，按全部来源条目判定）", { timeout: 60_000 }, () => {
  it("应用带进部署的插件：PUT /plugins 也受应用条目策略约束，最严格的来源生效；不经目录重装不清来源", async () => {
    const { itemId: pluginItem, sha256 } = await importDeployedPlugin(env, "dirplug");
    const row = await env.db
      .selectFrom("plugin_installs")
      .select("directory_item_id")
      .where("name", "=", "dirplug")
      .executeTakeFirstOrThrow();
    expect(row.directory_item_id).toBe(pluginItem);
    // 一个应用也把它带进了部署（应用包确认时登记来源，见 app-import.test）
    const appId = await seedApp(env, { templates: false, plugins: ["dirplug"], skills: [] });
    await env.db
      .insertInto("plugin_directory_sources")
      .values({ plugin: "dirplug", item_id: appId })
      .execute();
    const enable = (enabled: boolean) =>
      env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/plugins/dirplug`,
        payload: { enabled },
      });
    // 插件条目 allow、应用条目 disabled → 最严格的生效
    await setPolicy(env, appId, "disabled");
    const off = await enable(true);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe("directory.item_disabled");
    // 应用条目 needs_approval 且未授予 → approval_required；授予后可以启用
    await setPolicy(env, appId, "needs_approval");
    const pend = await enable(true);
    expect(pend.statusCode).toBe(403);
    expect(pend.json().error.code).toBe("directory.approval_required");
    expect((await install(env.boss, env, appId)).statusCode).toBe(202);
    await grant(appId);
    expect((await enable(true)).statusCode).toBe(200);
    expect((await enable(false)).statusCode).toBe(200);
    // 不经目录重装同一个包：来源条目保留，插件条目禁用后照样拦住
    await env.k.pluginAdminOps.install("dirplug", sha256, env.rootId);
    const kept = await env.db
      .selectFrom("plugin_installs")
      .select("directory_item_id")
      .where("name", "=", "dirplug")
      .executeTakeFirstOrThrow();
    expect(kept.directory_item_id).toBe(pluginItem);
    await setPolicy(env, pluginItem, "disabled");
    expect((await enable(true)).json().error.code).toBe("directory.item_disabled");
    // 删除条目即撤回它的约束
    await env.root({ method: "DELETE", url: `/api/v1/admin/directory/items/${pluginItem}` });
    expect((await enable(true)).statusCode).toBe(200);
  });

  it("插件从部署卸载时一并删除来源条目：之后不经目录重装不受旧条目的 needs_approval 约束（disabled 仍是总开关）", async () => {
    const { itemId, sha256 } = await importDeployedPlugin(env, "dirplug2");
    await setPolicy(env, itemId, "needs_approval");
    const enable = () =>
      env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/plugins/dirplug2`,
        payload: { enabled: true },
      });
    expect((await enable()).json().error.code).toBe("directory.approval_required");
    expect(
      (await env.root({ method: "POST", url: "/api/v1/admin/plugins/dirplug2/disable" }))
        .statusCode,
    ).toBe(200);
    await waitFor(async () => env.k.host.current("dirplug2") === undefined, 15_000, "unloaded");
    const del = await env.root({ method: "DELETE", url: "/api/v1/admin/plugins/dirplug2" });
    expect(del.statusCode, del.body).toBe(204);
    expect(
      await env.db
        .selectFrom("plugin_directory_sources")
        .select("item_id")
        .where("plugin", "=", "dirplug2")
        .execute(),
    ).toEqual([]);
    // 不经目录重装（同一个包，已在包存储里）：没有来源条目，不受条目 disabled 约束
    await env.k.pluginAdminOps.install("dirplug2", sha256, env.rootId);
    await env.k.pluginAdminOps.enable("dirplug2", env.rootId);
    await waitFor(async () => env.k.host.current("dirplug2") !== undefined, 15_000, "loaded");
    const row = await env.db
      .selectFrom("plugin_installs")
      .select("directory_item_id")
      .where("name", "=", "dirplug2")
      .executeTakeFirstOrThrow();
    expect(row.directory_item_id).toBeNull();
    // 插件自己的条目 disabled：不论有没有来源行都不能新启用（裁决 M-5）
    await setPolicy(env, itemId, "disabled");
    expect((await enable()).json().error.code).toBe("directory.item_disabled");
    await setPolicy(env, itemId, "needs_approval");
    const ok = await enable();
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe("技能来源跟着最新版本走（已有同名技能时）", { timeout: 60_000 }, () => {
  const skillRow = (id: string) =>
    env.db
      .selectFrom("skills")
      .select(["current_version", "directory_item_id", "directory_version"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  const customUpload = async () => {
    const md = new TextEncoder().encode(SKILL_MD("pdf-tools"));
    return env.k.skills.createVersionFromFiles(env.orgId, env.bossId, {
      name: "pdf-tools",
      description: "Custom",
      files: [
        {
          path: "SKILL.md",
          size: md.byteLength,
          sha256: createHash("sha256").update(md).digest("hex"),
          data: md,
        },
      ],
    });
  };

  it("同名自建技能上装目录技能：记下条目与版本，清单显示已装，再点安装不会叠版本", async () => {
    const custom = await customUpload();
    expect(custom.created).toBe(true);
    const itemId = await importSkill(env);
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toBeNull();
    const r = await install(env.boss, env, itemId);
    expect(r.statusCode, r.body).toBe(201);
    expect(await skillRow(custom.skill.id)).toEqual({
      current_version: 2,
      directory_item_id: itemId,
      directory_version: "1.0.0",
    });
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toMatchObject({
      skillId: custom.skill.id,
      version: "1.0.0",
    });
    const admin = await env.root({ method: "GET", url: "/api/v1/admin/directory/items" });
    const listed = (admin.json() as { items: { id: string; installs: number }[] }).items;
    expect(listed.find((i) => i.id === itemId)?.installs).toBe(1);
  });

  it("升级：装新版本后记新版本号", async () => {
    const itemId = await importSkill(env);
    const first = await install(env.boss, env, itemId);
    expect(first.statusCode, first.body).toBe(201);
    const skillId = (first.json() as { installed: { skillId: string } }).installed.skillId;
    await importSkill(env, { version: "2.0.0" });
    const up = await install(env.boss, env, itemId, { version: "2.0.0" });
    expect(up.statusCode, up.body).toBe(201);
    expect(await skillRow(skillId)).toEqual({
      current_version: 2,
      directory_item_id: itemId,
      directory_version: "2.0.0",
    });
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toMatchObject({
      skillId,
      version: "2.0.0",
    });
  });

  it("目录技能上再自建上传：清掉目录来源（内容已是自定义的）", async () => {
    const itemId = await importSkill(env);
    const first = await install(env.boss, env, itemId);
    expect(first.statusCode, first.body).toBe(201);
    const skillId = (first.json() as { installed: { skillId: string } }).installed.skillId;
    const custom = await customUpload();
    expect(custom.skill.id).toBe(skillId);
    expect(await skillRow(skillId)).toEqual({
      current_version: 2,
      directory_item_id: null,
      directory_version: null,
    });
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toBeNull();
    const versions = await env.db
      .selectFrom("skill_versions")
      .select(["version", "directory_item_id", "directory_version"])
      .where("skill_id", "=", skillId)
      .orderBy("version")
      .execute();
    expect(versions).toEqual([
      { version: 1, directory_item_id: itemId, directory_version: "1.0.0" },
      { version: 2, directory_item_id: null, directory_version: null },
    ]);
  });
});

describe("自建开关与权限", { timeout: 60_000 }, () => {
  it("customConnectors / customSkills 为 deny：自建 403，从目录安装不受影响", async () => {
    await setDeployment(env, { customConnectors: "deny", customSkills: "deny" });
    const custom = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors`,
      payload: {
        name: "Mine",
        connector: "mcp",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(custom.statusCode).toBe(403);
    expect(custom.json().error.code).toBe("directory.custom_disabled");
    const upload = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/skills/uploads`,
      payload: { name: "s.zip", size: 100 },
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.json().error.code).toBe("directory.custom_disabled");
    const create = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/skills`,
      payload: { uploadId: randomUUID() },
    });
    expect(create.json().error.code).toBe("directory.custom_disabled");

    // 预览也不替组织连任意端点
    const preview = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors/preview`,
      payload: {
        connector: "mcp",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(preview.statusCode).toBe(403);
    expect(preview.json().error.code).toBe("directory.custom_disabled");

    const tpl = await importTemplate(env);
    // 目录安装的凭据同样限大小（与自建连接器的 CredentialValue 一致）
    const huge = await install(
      env.boss,
      env,
      tpl,
      connectorBody({ credential: { token: "x".repeat(20_000) } }),
    );
    expect(huge.statusCode).toBe(400);
    expect((await install(env.boss, env, tpl, connectorBody())).statusCode).toBe(201);
    const skill = await importSkill(env);
    expect((await install(env.boss, env, skill)).statusCode).toBe(201);

    await setDeployment(env, { customConnectors: "allow" });
    const allowed = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/connectors`,
      payload: {
        name: "Mine",
        connector: "mcp",
        endpoint: { url: env.mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      },
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it("成员不能安装（锁内按种类复核）；访客不能浏览；企业管理员看到安装数", async () => {
    const itemId = await importSkill(env);
    const r = await install(env.mem, env, itemId);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
    // 成员拿 disabled 条目 / 不存在的版本：先判角色，一律 forbidden（不能借错误码探测条目）
    const off = await importSkill(env, {
      name: "@acme/skill-off",
      skillName: "off",
      policy: "disabled",
    });
    for (const body of [{}, { version: "9.9.9" }, { connector: {} }]) {
      const x = await install(env.mem, env, off, body);
      expect(x.json().error.code).toBe("forbidden");
    }
    expect(await env.db.selectFrom("skills").select("id").execute()).toHaveLength(0);
    await env.db
      .updateTable("memberships")
      .set({ role: "guest" })
      .where("account_id", "=", env.memId)
      .execute();
    try {
      const g = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/directory` });
      expect(g.statusCode).toBe(403);
    } finally {
      await env.db
        .updateTable("memberships")
        .set({ role: "member" })
        .where("account_id", "=", env.memId)
        .execute();
    }
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const admin = await env.root({ method: "GET", url: "/api/v1/admin/directory/items" });
    const item = (admin.json() as { items: { id: string; installs: number }[] }).items.find(
      (i) => i.id === itemId,
    );
    expect(item?.installs).toBe(1);
  });

  it("组织管理员被降级后再安装：锁内复核拒绝", async () => {
    const itemId = await importSkill(env);
    await env.db
      .updateTable("memberships")
      .set({ role: "member" })
      .where("account_id", "=", env.bossId)
      .execute();
    try {
      const r = await install(env.boss, env, itemId);
      expect(r.statusCode).toBe(403);
    } finally {
      await env.db
        .updateTable("memberships")
        .set({ role: "admin" })
        .where("account_id", "=", env.bossId)
        .execute();
    }
  });
});

describe("条目详情与图标（安装向导、网页只以 <img> 显示）", { timeout: 60_000 }, () => {
  it("图标经内核路由给出：svg 类型、nosniff、CSP sandbox；没有图标 404；成员看不到 disabled 的图标", async () => {
    const itemId = await importTemplate(env);
    for (const [req, url] of [
      [env.mem, `/api/v1/orgs/${env.orgId}/directory/${itemId}/icon`],
      [env.root, `/api/v1/admin/directory/items/${itemId}/icon`],
    ] as const) {
      const r = await req({ method: "GET", url });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["content-type"]).toBe("image/svg+xml");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(r.body).toContain("<svg");
    }
    const skillId = await importSkill(env);
    const none = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${skillId}/icon`,
    });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("directory.icon_not_found");
    await setPolicy(env, itemId, "disabled");
    const hidden = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${itemId}/icon`,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("directory.item_not_found");
    const admin = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${itemId}/icon`,
    });
    expect(admin.statusCode).toBe(200);
  });

  it("没有图标的 disabled 条目：成员得到 item_not_found（不因「没有图标」暴露条目存在）", async () => {
    const skillId = await importSkill(env, { policy: "disabled" });
    const r = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${skillId}/icon`,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("directory.item_not_found");
    const admin = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${skillId}/icon`,
    });
    expect(admin.json().error.code).toBe("directory.icon_not_found");
  });

  it("申请带申请人的显示名（收件箱卡片显示）", async () => {
    const itemId = await importSkill(env);
    const r = await requestItem(env.mem, env, itemId, "please");
    expect(r.statusCode, r.body).toBe(201);
    const inbox = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/inbox` });
    const item = (
      inbox.json() as { items: { type: string; request?: Record<string, unknown> }[] }
    ).items.find((i) => i.type === "directory_request");
    expect(item?.request).toMatchObject({ requestedBy: env.memId, requestedByName: "M" });
  });

  it("后台详情给出 hasIcon：模板有图标为 true，技能为 false", async () => {
    const tplId = await importTemplate(env);
    const skillId = await importSkill(env);
    const t = await env.root({ method: "GET", url: `/api/v1/admin/directory/items/${tplId}` });
    expect(t.json().hasIcon).toBe(true);
    const k = await env.root({ method: "GET", url: `/api/v1/admin/directory/items/${skillId}` });
    expect(k.json().hasIcon).toBe(false);
  });

  it("详情：成员看不到 disabled 的条目（404），组织管理员看得到", async () => {
    const itemId = await importSkill(env, { policy: "disabled" });
    const url = `/api/v1/orgs/${env.orgId}/directory/${itemId}`;
    const hidden = await env.mem({ method: "GET", url });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("directory.item_not_found");
    const admin = await env.boss({ method: "GET", url });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().item).toMatchObject({ id: itemId, installable: "disabled" });
  });

  it("详情：连接器模板给出端点预设、可改路径与认证预设；应用给出模板、插件与技能", async () => {
    const tplId = await importTemplate(env);
    const r = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${tplId}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const tpl = mcpTemplate();
    expect(r.json()).toMatchObject({
      item: { id: tplId, kind: "connector-template", installable: "yes" },
      hasIcon: true,
      templates: [
        {
          id: "connector",
          plugin: tpl.plugin,
          connector: tpl.connector,
          endpoint: tpl.endpoint,
          editableEndpoint: tpl.editableEndpoint ?? [],
          auth: tpl.auth,
        },
      ],
      plugins: [],
      skills: [],
    });
    expect(r.json().item).not.toHaveProperty("catalogSourceId");
    const appId = await seedApp(env);
    const a = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/directory/${appId}` });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({
      item: { id: appId, kind: "app" },
      hasIcon: false,
      templates: [{ id: "gh", displayName: { en: "GitHub" }, connector: "mcp" }],
      plugins: [
        { name: "todo", range: "^0.1.0", optional: false },
        { name: "example-counter", range: "^0.1.0", optional: false },
      ],
      skills: ["skills/pdf-tools"],
    });
    const missing = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/directory/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
