import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditActions,
  importSkill,
  importTemplate,
  install,
  MCP_TOKEN,
  type OrgEnv,
  resetOrgDirectory,
  seedApp,
  seedPluginItem,
  setDeployment,
  setPolicy,
  startOrgEnv,
} from "./org-env.js";
import { mcpTemplate } from "./packages.js";

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

describe("组织从目录安装：三档策略", () => {
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

  it("应用条目：三档策略对应用生效（应用里的插件按应用条目策略，不看插件条目）", async () => {
    // 插件条目本身禁用：应用里的插件仍按应用条目策略启用
    await seedPluginItem(env, "todo", "disabled");
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
});

describe("自建开关与权限", () => {
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

    const tpl = await importTemplate(env);
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
