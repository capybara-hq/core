import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  auditActions,
  importDeployedPlugin,
  importPlugin,
  importSkill,
  importTemplate,
  install,
  MCP_TOKEN,
  type OrgEnv,
  requestItem,
  resetOrgCatalog,
  seedPlugin,
  seedPluginItem,
  setDeployment,
  setPolicy,
  startOrgEnv,
  TEMPLATE_ID,
} from "./org-env.js";
import { mcpTemplate, templatePlugin } from "./packages.js";

let env: OrgEnv;

beforeAll(async () => {
  env = await startOrgEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await resetOrgCatalog(env);
});

type Item = {
  id: string;
  installable: string;
  installed: Record<string, string> | null;
  request: { id: string; stage: string; status: string } | null;
};

async function orgList(req: OrgEnv["root"]): Promise<Item[]> {
  const r = await req({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: Item[] }).items;
}

async function grant(itemId: string): Promise<void> {
  const reqs = await env.root({ method: "GET", url: "/api/v1/admin/catalog/requests" });
  const pending = (reqs.json() as { requests: { id: string; item: { id: string } }[] }).requests;
  const r = pending.find((x) => x.item.id === itemId);
  expect(r).toBeDefined();
  const d = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/requests/${r?.id}/decide`,
    payload: { decision: "approve" },
  });
  expect(d.statusCode, d.body).toBe(200);
}

/** The install body for {@link importTemplate}'s plugin: its one template's connector input. */
const connectorBody = (over: Record<string, unknown> = {}) =>
  templateBody({
    name: "GitHub",
    endpoint: { url: env.mcp.url },
    credential: { token: MCP_TOKEN },
    ...over,
  });
const templateBody = (input: Record<string, unknown>) => ({
  connectors: { [TEMPLATE_ID]: input },
});

/** The plugin install of an item in the org (from the org list). */
async function installOf(itemId: string): Promise<string> {
  const id = (await orgList(env.boss)).find((i) => i.id === itemId)?.installed?.pluginInstallId;
  expect(id).toBeDefined();
  return id as string;
}

/** Uninstalls the item's plugin install in the org. */
async function uninstall(itemId: string): Promise<void> {
  const r = await env.boss({
    method: "DELETE",
    url: `/api/v1/orgs/${env.orgId}/plugin-installs/${await installOf(itemId)}`,
  });
  expect(r.statusCode, r.body).toBe(200);
}

/** The org skill created from an item. */
const skillOfItem = (itemId: string) =>
  env.db
    .selectFrom("skills")
    .select(["id", "catalog_item_id", "catalog_version", "name", "current_version"])
    .where("catalog_item_id", "=", itemId)
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();

describe("组织从目录安装：三档策略", { timeout: 60_000 }, () => {
  it("技能：allow 直接装；disabled 拒绝且成员看不到；needs_approval 经企业管理员批准后才能装", async () => {
    const itemId = await importSkill(env);
    // allow
    const ok = await install(env.boss, env, itemId);
    expect(ok.statusCode, ok.body).toBe(201);
    const pluginInstallId = (ok.json() as { installed: { pluginInstallId: string } }).installed
      .pluginInstallId;
    expect(await skillOfItem(itemId)).toMatchObject({
      catalog_item_id: itemId,
      catalog_version: "1.0.0",
      name: "pdf-tools",
    });
    expect(await auditActions(env)).toContain("plugin.org_installed");
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toEqual({
      pluginInstallId,
      version: "1.0.0",
    });
    // 已装的不受 disabled 影响，但不能新装
    await setPolicy(env, itemId, "disabled");
    const off = await install(env.boss, env, itemId);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe("catalog.item_disabled");
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
    // Installed already: uninstall, then install again with the grant
    const dup = await install(env.boss, env, itemId);
    expect(dup.json().error.code).toBe("plugin.already_installed");
    await uninstall(itemId);
    const again = await install(env.boss, env, itemId);
    expect(again.statusCode, again.body).toBe(201);
  });

  it("连接器模板：按模板建连接器，凭据进 secrets、默认策略 template；disabled 403；needs_approval 202", async () => {
    const itemId = await importTemplate(env);
    const ok = await install(env.boss, env, itemId, connectorBody());
    expect(ok.statusCode, ok.body).toBe(201);
    const c = await env.db
      .selectFrom("connectors")
      .select(["id", "catalog_item_id", "catalog_version", "endpoint", "auth"])
      .where("catalog_item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    const connectorId = c.id;
    expect(c).toMatchObject({
      catalog_item_id: itemId,
      catalog_version: "1.0.0",
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
    expect(off.json().error.code).toBe("catalog.item_disabled");
    await setPolicy(env, itemId, "needs_approval");
    const pend = await install(env.boss, env, itemId, connectorBody({ slug: "gh2" }));
    expect(pend.statusCode).toBe(202);
    await grant(itemId);
    await uninstall(itemId);
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
    expect(JSON.stringify(bad.json().error)).toContain(
      `connectors.${TEMPLATE_ID}.endpoint.headers`,
    );
    const withAuth = await install(
      env.boss,
      env,
      itemId,
      templateBody({ endpoint: { url: env.mcp.url }, auth: { type: "none" } }),
    );
    expect(withAuth.statusCode).toBe(400);
    // Credential-like URL user info is refused on the merged endpoint too (the template only allows url)
    const leak = await install(
      env.boss,
      env,
      itemId,
      templateBody({
        endpoint: { url: `https://user:pw@127.0.0.1/mcp` },
        credential: { token: "x" },
      }),
    );
    expect(leak.statusCode).not.toBe(201);
    expect(await env.db.selectFrom("connectors").select("id").execute()).toHaveLength(0);
  });

  it("OAuth 模板：组织安装时按部署的 OAuth 地址策略复核 tokenUrl（导入时只做了静态校验）", async () => {
    const itemId = await importTemplate(env, {
      name: "oauth-mcp",
      template: mcpTemplate({
        auth: { type: "oauth_client", ownership: "org", tokenUrl: "http://token.example.com/t" },
        defaultToolPolicies: {},
      }),
    });
    const r = await install(
      env.boss,
      env,
      itemId,
      templateBody({
        endpoint: { url: env.mcp.url },
        client: { clientId: "c", clientSecret: "s" },
      }),
    );
    expect(r.statusCode, r.body).not.toBe(201);
    expect(JSON.stringify(r.json().error)).toContain("auth.tokenUrl");
    // An OAuth template takes a client, never a static credential
    const wrong = await install(
      env.boss,
      env,
      itemId,
      templateBody({ endpoint: { url: env.mcp.url }, credential: { token: "x" } }),
    );
    // The plugin installer reports a failed step as plugin.install_failed with the cause
    expect(wrong.statusCode).not.toBe(201);
    expect(JSON.stringify(wrong.json().error)).toContain("validation_failed");
    expect(await env.db.selectFrom("connectors").select("id").execute()).toHaveLength(0);
  });

  it("授权码模板：安装时没有快照，首个快照时按模板 defaultToolPolicies 设默认策略（policy_source template）", async () => {
    const itemId = await importTemplate(env, {
      name: "code-mcp",
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
    const r = await install(
      env.boss,
      env,
      itemId,
      templateBody({ endpoint: { url: env.mcp.url }, client: { clientId: "c" } }),
    );
    expect(r.statusCode, r.body).toBe(201);
    const connectorId = (
      await env.db
        .selectFrom("connectors")
        .select("id")
        .where("catalog_item_id", "=", itemId)
        .executeTakeFirstOrThrow()
    ).id;
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
      .selectFrom("extension_org_configs")
      .select("enabled")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(enabled.enabled).toBe(true);
    // 停用后再装 = 新装，受策略约束
    await env.root({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/extensions/todo`,
      payload: { enabled: false },
    });
    await setPolicy(env, itemId, "disabled");
    expect((await install(env.boss, env, itemId)).json().error.code).toBe("catalog.item_disabled");
    await setPolicy(env, itemId, "needs_approval");
    expect((await install(env.boss, env, itemId)).statusCode).toBe(202);
    await grant(itemId);
    await uninstall(itemId);
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    // An extension not on the deployment
    const ghost = await seedPluginItem(env, "ghost");
    expect((await orgList(env.boss)).find((i) => i.id === ghost)?.installable).toBe("not_deployed");
    const nd = await install(env.boss, env, ghost);
    expect(nd.statusCode).toBe(409);
    expect(nd.json().error.code).toBe("catalog.not_deployed");
  });

  it("a plugin with an extension, a template and a skill: one install, its policy only (not the extension item's)", async () => {
    // Another item with the same extension name is irrelevant: the installed plugin's policy decides
    const appId = await seedPlugin(env, { name: "todo", extension: true });
    await setPolicy(env, appId, "disabled");
    expect((await install(env.boss, env, appId)).json().error.code).toBe("catalog.item_disabled");
    await setPolicy(env, appId, "needs_approval");
    const pend = await install(env.boss, env, appId);
    expect(pend.statusCode).toBe(202);
    await grant(appId);
    const ok = await install(env.boss, env, appId, {
      connectors: { gh: { endpoint: { url: env.mcp.url }, credential: { token: MCP_TOKEN } } },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().installed.pluginInstallId).toEqual(expect.any(String));
    expect((await orgList(env.boss)).find((i) => i.id === appId)?.installed).toMatchObject({
      pluginInstallId: ok.json().installed.pluginInstallId,
    });
    const comps = await env.db
      .selectFrom("plugin_install_components")
      .select(["kind", "created"])
      .orderBy("kind")
      .execute();
    expect(comps).toEqual([
      { kind: "connector", created: true },
      { kind: "extension", created: true },
      { kind: "skill", created: true },
    ]);
    // The plugin's extension not on the deployment
    const ghostApp = await seedPlugin(env, { name: "ghost", extension: true, templates: false });
    expect((await orgList(env.boss)).find((i) => i.id === ghostApp)?.installable).toBe(
      "not_deployed",
    );
    const nd = await install(env.boss, env, ghostApp);
    expect(nd.json().error.code).toBe("catalog.not_deployed");
  });

  it("the extension's own item disabled is a master switch for newly enabling it; already enabled is unaffected (Ruling M-5)", async () => {
    const appId = await seedPlugin(env, {
      name: "todo",
      extension: true,
      templates: false,
      policy: "disabled",
    });
    const r = await install(env.boss, env, appId);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.code).toBe("catalog.item_disabled");
    expect(await env.db.selectFrom("plugin_installs").select("id").execute()).toEqual([]);
    const enable = () =>
      env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/extensions/todo`,
        payload: { enabled: true },
      });
    // Enabling it directly is refused too (no source row needed)
    expect((await enable()).json().error.code).toBe("catalog.item_disabled");
    await setPolicy(env, appId, "allow");
    expect((await enable()).statusCode).toBe(200);
    await setPolicy(env, appId, "disabled");
    const cfg = await env.db
      .selectFrom("extension_org_configs")
      .select("enabled")
      .where("org_id", "=", env.orgId)
      .where("plugin", "=", "todo")
      .executeTakeFirstOrThrow();
    expect(cfg.enabled).toBe(true);
    // Enabled before: an install records the extension created=false
    await setPolicy(env, appId, "allow");
    const ok = await install(env.boss, env, appId);
    expect(ok.statusCode, ok.body).toBe(201);
    const comps = await env.db
      .selectFrom("plugin_install_components")
      .select(["kind", "ref", "created"])
      .where("kind", "=", "extension")
      .execute();
    expect(comps).toEqual([{ kind: "extension", ref: "todo", created: false }]);
  });

  it("a template's connector extension pluginVersion not satisfied by the loaded one -> catalog.not_deployed at install; refused at import too", async () => {
    const tpl = await importTemplate(env);
    // Edit the stored template directly (the import checked it against the loaded version)
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["object_prefix", "files"])
      .where("item_id", "=", tpl)
      .executeTakeFirstOrThrow();
    const path = `connectors/${TEMPLATE_ID}.json`;
    const data = new TextEncoder().encode(
      JSON.stringify({
        displayName: { zh: "GitHub", en: "GitHub" },
        template: mcpTemplate({ pluginVersion: "^9.0.0" }),
      }),
    );
    await env.k.storage.deployment().put(`${v.object_prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    await env.db
      .updateTable("catalog_item_versions")
      .set({
        files: JSON.stringify(
          v.files.map((f) =>
            f.path === path
              ? {
                  path,
                  size: data.byteLength,
                  sha256: createHash("sha256").update(data).digest("hex"),
                }
              : f,
          ),
        ),
      })
      .where("item_id", "=", tpl)
      .execute();
    const r = await install(env.boss, env, tpl, connectorBody());
    expect(r.json().error.details?.[0]?.code ?? r.json().error.code).toBe("catalog.not_deployed");
    const bad = await env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await templatePlugin("other", mcpTemplate({ pluginVersion: "^9.0.0" }))),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.body).toContain("pluginVersion");
  });
});

describe("直接启用来自目录的插件（C22，按全部来源条目判定）", { timeout: 60_000 }, () => {
  it("应用带进部署的插件：PUT /plugins 也受应用条目策略约束，最严格的来源生效；不经目录重装不清来源", async () => {
    const { itemId: pluginItem, sha256 } = await importDeployedPlugin(env, "dirplug");
    const row = await env.db
      .selectFrom("extension_installs")
      .select("catalog_item_id")
      .where("name", "=", "dirplug")
      .executeTakeFirstOrThrow();
    expect(row.catalog_item_id).toBe(pluginItem);
    // Another plugin item brought it into the deployment too (the source is recorded when an item's
    // extension is installed on the deployment)
    const appId = await seedPlugin(env, { name: "dirplug-bundle", templates: false });
    await env.db
      .insertInto("extension_catalog_sources")
      .values({ plugin: "dirplug", item_id: appId })
      .execute();
    const enable = (enabled: boolean) =>
      env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/extensions/dirplug`,
        payload: { enabled },
      });
    // 插件条目 allow、应用条目 disabled → 最严格的生效
    await setPolicy(env, appId, "disabled");
    const off = await enable(true);
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe("catalog.item_disabled");
    // 应用条目 needs_approval 且未授予 → approval_required；授予后可以启用
    await setPolicy(env, appId, "needs_approval");
    const pend = await enable(true);
    expect(pend.statusCode).toBe(403);
    expect(pend.json().error.code).toBe("catalog.approval_required");
    expect((await install(env.boss, env, appId)).statusCode).toBe(202);
    await grant(appId);
    expect((await enable(true)).statusCode).toBe(200);
    expect((await enable(false)).statusCode).toBe(200);
    // 不经目录重装同一个包：来源条目保留，插件条目禁用后照样拦住
    await env.k.extensionAdminOps.install("dirplug", sha256, env.rootId);
    const kept = await env.db
      .selectFrom("extension_installs")
      .select("catalog_item_id")
      .where("name", "=", "dirplug")
      .executeTakeFirstOrThrow();
    expect(kept.catalog_item_id).toBe(pluginItem);
    await setPolicy(env, pluginItem, "disabled");
    expect((await enable(true)).json().error.code).toBe("catalog.item_disabled");
    // 删除条目即撤回它的约束
    await env.root({ method: "DELETE", url: `/api/v1/admin/catalog/items/${pluginItem}` });
    expect((await enable(true)).statusCode).toBe(200);
  });

  it("插件从部署卸载时一并删除来源条目：之后不经目录重装不受旧条目的 needs_approval 约束（disabled 仍是总开关）", async () => {
    const { itemId, sha256 } = await importDeployedPlugin(env, "dirplug2");
    await setPolicy(env, itemId, "needs_approval");
    const enable = () =>
      env.boss({
        method: "PUT",
        url: `/api/v1/orgs/${env.orgId}/extensions/dirplug2`,
        payload: { enabled: true },
      });
    expect((await enable()).json().error.code).toBe("catalog.approval_required");
    expect(
      (await env.root({ method: "POST", url: "/api/v1/admin/extensions/dirplug2/disable" }))
        .statusCode,
    ).toBe(200);
    await waitFor(async () => env.k.host.current("dirplug2") === undefined, 15_000, "unloaded");
    const del = await env.root({ method: "DELETE", url: "/api/v1/admin/extensions/dirplug2" });
    expect(del.statusCode, del.body).toBe(204);
    expect(
      await env.db
        .selectFrom("extension_catalog_sources")
        .select("item_id")
        .where("plugin", "=", "dirplug2")
        .execute(),
    ).toEqual([]);
    // 不经目录重装（同一个包，已在包存储里）：没有来源条目，不受条目 disabled 约束
    await env.k.extensionAdminOps.install("dirplug2", sha256, env.rootId);
    await env.k.extensionAdminOps.enable("dirplug2", env.rootId);
    await waitFor(async () => env.k.host.current("dirplug2") !== undefined, 15_000, "loaded");
    const row = await env.db
      .selectFrom("extension_installs")
      .select("catalog_item_id")
      .where("name", "=", "dirplug2")
      .executeTakeFirstOrThrow();
    expect(row.catalog_item_id).toBeNull();
    // 插件自己的条目 disabled：不论有没有来源行都不能新启用（裁决 M-5）
    await setPolicy(env, itemId, "disabled");
    expect((await enable()).json().error.code).toBe("catalog.item_disabled");
    await setPolicy(env, itemId, "needs_approval");
    const ok = await enable();
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe("skill provenance follows the latest version (a skill of the same name exists)", {
  timeout: 60_000,
}, () => {
  const skillRow = (id: string) =>
    env.db
      .selectFrom("skills")
      .select(["current_version", "catalog_item_id", "catalog_version"])
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

  it("a catalog skill over the org's own skill of the same name: 409 plugin.skill_conflict, the skill and the org list unchanged", async () => {
    const custom = await customUpload();
    expect(custom.created).toBe(true);
    const itemId = await importSkill(env);
    const r = await install(env.boss, env, itemId);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "plugin.skill_conflict",
      message:
        'Skill "pdf-tools" already exists in this org (source: the org\'s own skill). Remove or rename it, then install again.',
    });
    expect(await skillRow(custom.skill.id)).toEqual({
      current_version: 1,
      catalog_item_id: null,
      catalog_version: null,
    });
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toBeNull();
    expect(await env.db.selectFrom("plugin_installs").select("id").execute()).toEqual([]);
  });

  it("a newer version installed after uninstalling the old one records the new version", async () => {
    const itemId = await importSkill(env);
    const first = await install(env.boss, env, itemId);
    expect(first.statusCode, first.body).toBe(201);
    await importSkill(env, { version: "2.0.0" });
    await uninstall(itemId);
    const up = await install(env.boss, env, itemId, { version: "2.0.0" });
    expect(up.statusCode, up.body).toBe(201);
    expect(await skillOfItem(itemId)).toMatchObject({
      current_version: 1,
      catalog_item_id: itemId,
      catalog_version: "2.0.0",
    });
    expect((await orgList(env.boss)).find((i) => i.id === itemId)?.installed).toMatchObject({
      version: "2.0.0",
    });
  });

  it("目录技能上再自建上传：清掉目录来源（内容已是自定义的）", async () => {
    const itemId = await importSkill(env);
    const first = await install(env.boss, env, itemId);
    expect(first.statusCode, first.body).toBe(201);
    const skillId = (await skillOfItem(itemId)).id;
    const custom = await customUpload();
    expect(custom.skill.id).toBe(skillId);
    expect(await skillRow(skillId)).toEqual({
      current_version: 2,
      catalog_item_id: null,
      catalog_version: null,
    });
    const versions = await env.db
      .selectFrom("skill_versions")
      .select(["version", "catalog_item_id", "catalog_version"])
      .where("skill_id", "=", skillId)
      .orderBy("version")
      .execute();
    expect(versions).toEqual([
      { version: 1, catalog_item_id: itemId, catalog_version: "1.0.0" },
      { version: 2, catalog_item_id: null, catalog_version: null },
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
    expect(custom.json().error.code).toBe("catalog.custom_disabled");
    const upload = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/skills/uploads`,
      payload: { name: "s.zip", size: 100 },
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.json().error.code).toBe("catalog.custom_disabled");
    const create = await env.boss({
      method: "POST",
      url: `/api/v1/orgs/${env.orgId}/skills`,
      payload: { uploadId: randomUUID() },
    });
    expect(create.json().error.code).toBe("catalog.custom_disabled");

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
    expect(preview.json().error.code).toBe("catalog.custom_disabled");

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
    const off = await importSkill(env, { name: "off", policy: "disabled" });
    for (const body of [{}, { version: "9.9.9" }, { connectors: {} }]) {
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
      const g = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog` });
      expect(g.statusCode).toBe(403);
    } finally {
      await env.db
        .updateTable("memberships")
        .set({ role: "member" })
        .where("account_id", "=", env.memId)
        .execute();
    }
    expect((await install(env.boss, env, itemId)).statusCode).toBe(201);
    const admin = await env.root({ method: "GET", url: "/api/v1/admin/catalog/items" });
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
  /** A templates-only plugin whose plugin.json has an icon (the item's icon). */
  const importIconPlugin = async () =>
    importPlugin(
      env,
      await templatePlugin(TEMPLATE_ID, mcpTemplate(), {
        manifest: { icon: `./icons/${TEMPLATE_ID}.svg` },
      }),
    );

  it("图标经内核路由给出：svg 类型、nosniff、CSP sandbox；没有图标 404；成员看不到 disabled 的图标", async () => {
    const itemId = await importIconPlugin();
    for (const [req, url] of [
      [env.mem, `/api/v1/orgs/${env.orgId}/catalog/${itemId}/icon`],
      [env.root, `/api/v1/admin/catalog/items/${itemId}/icon`],
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
      url: `/api/v1/orgs/${env.orgId}/catalog/${skillId}/icon`,
    });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("catalog.icon_not_found");
    await setPolicy(env, itemId, "disabled");
    const hidden = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/icon`,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("catalog.item_not_found");
    const admin = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/icon`,
    });
    expect(admin.statusCode).toBe(200);
  });

  it("没有图标的 disabled 条目：成员得到 item_not_found（不因「没有图标」暴露条目存在）", async () => {
    const skillId = await importSkill(env, { policy: "disabled" });
    const r = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${skillId}/icon`,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("catalog.item_not_found");
    const admin = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${skillId}/icon`,
    });
    expect(admin.json().error.code).toBe("catalog.icon_not_found");
  });

  it("申请带申请人的显示名（收件箱卡片显示）", async () => {
    const itemId = await importSkill(env);
    const r = await requestItem(env.mem, env, itemId, "please");
    expect(r.statusCode, r.body).toBe(201);
    const inbox = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/inbox` });
    const item = (
      inbox.json() as { items: { type: string; request?: Record<string, unknown> }[] }
    ).items.find((i) => i.type === "catalog_request");
    expect(item?.request).toMatchObject({ requestedBy: env.memId, requestedByName: "M" });
  });

  it("the admin detail gives hasIcon: true for a plugin with an icon, false without", async () => {
    const tplId = await importIconPlugin();
    const skillId = await importSkill(env);
    const t = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${tplId}` });
    expect(t.json().hasIcon).toBe(true);
    const k = await env.root({ method: "GET", url: `/api/v1/admin/catalog/items/${skillId}` });
    expect(k.json().hasIcon).toBe(false);
  });

  it("详情：成员看不到 disabled 的条目（404），组织管理员看得到", async () => {
    const itemId = await importSkill(env, { policy: "disabled" });
    const url = `/api/v1/orgs/${env.orgId}/catalog/${itemId}`;
    const hidden = await env.mem({ method: "GET", url });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe("catalog.item_not_found");
    const admin = await env.boss({ method: "GET", url });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().item).toMatchObject({ id: itemId, installable: "disabled" });
  });

  it("detail: the templates (endpoint preset, editable paths, auth preset), the extension, dependencies and skills", async () => {
    const tplId = await importIconPlugin();
    const r = await env.boss({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${tplId}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const tpl = mcpTemplate();
    expect(r.json()).toMatchObject({
      item: { id: tplId, installable: "yes" },
      hasIcon: true,
      extension: null,
      dependencies: [],
      templates: [
        {
          id: TEMPLATE_ID,
          plugin: tpl.plugin,
          connector: tpl.connector,
          endpoint: tpl.endpoint,
          editableEndpoint: tpl.editableEndpoint ?? [],
          auth: tpl.auth,
        },
      ],
      skills: [],
    });
    expect(r.json().item).not.toHaveProperty("marketplaceId");
    expect(r.json().item).not.toHaveProperty("kind");
    const appId = await seedPlugin(env, {
      name: "todo",
      extension: true,
      dependencies: [{ name: "example-counter", version: "^0.1.0" }],
    });
    const a = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/catalog/${appId}` });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({
      item: { id: appId },
      hasIcon: false,
      extension: "todo",
      templates: [{ id: "gh", displayName: { en: "GitHub" }, connector: "mcp" }],
      dependencies: [{ name: "example-counter", range: "^0.1.0" }],
      skills: ["skills/pdf-tools"],
    });
    const missing = await env.mem({
      method: "GET",
      url: `/api/v1/orgs/${env.orgId}/catalog/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
