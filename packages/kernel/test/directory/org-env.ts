import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeMcpServer,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { expect } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, PW, type Req, runConfig, session, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { mcpTemplate, skillTgz, templateTgz } from "./packages.js";

// Literal paths (no helper that interpolates the plugin name) so the test-plugins check can see which
// official plugins these tests load; see tools/ci/test-plugins.json.
const OBJECT_STORE_S3 = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);
const TODO = fileURLToPath(new URL("../../../../plugins/todo/src/index.ts", import.meta.url));
const EXAMPLE_COUNTER = fileURLToPath(
  new URL("../../../../plugins/example-counter/src/index.ts", import.meta.url),
);

function templateNoIcon() {
  const { icon: _icon, ...t } = mcpTemplate();
  return t;
}

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

/** 假 MCP 服务要求的 bearer。 */
export const MCP_TOKEN = "tok-123";

/** 组织侧目录测试的环境：PG + Redis + SeaweedFS + 假 MCP；内核加载 connector-mcp、todo、example-counter。 */
export interface OrgEnv {
  k: Kernel;
  db: KernelDb;
  mcp: FakeMcpServer;
  /** 企业管理员（也是组织所有者）。 */
  root: Req;
  rootId: string;
  /** 组织管理员（不是企业管理员）。 */
  boss: Req;
  bossId: string;
  /** 组织成员。 */
  mem: Req;
  memId: string;
  orgId: string;
  stop(): Promise<void>;
}

export async function startOrgEnv(): Promise<OrgEnv> {
  let pgc: TestContainer | undefined;
  let rd: TestContainer | undefined;
  let s3: TestS3 | undefined;
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  const raw = createDb(pgc.url, 3);
  const db = kernelDb(raw);
  const pluginsDir = await mkdtemp(join(tmpdir(), "kernel-org-directory-"));
  const mcp = await startFakeMcpServer({
    requireBearer: MCP_TOKEN,
    tools: [
      {
        name: "search",
        description: "Search the docs",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
        handler: () => ({ content: [{ type: "text", text: "ok" }] }),
      },
      {
        name: "delete_all",
        description: "Delete everything",
        inputSchema: { type: "object", properties: {} },
        annotations: { destructiveHint: true },
        handler: () => ({ content: [{ type: "text", text: "gone" }] }),
      },
    ],
  });
  const config = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      roles: ["api", "worker"],
      pluginHost: { dir: pluginsDir },
      plugins: [
        OBJECT_STORE_S3,
        MODEL_FAKE,
        CONNECTOR_MCP,
        TODO,
        EXAMPLE_COUNTER,
        fixture("dep-provider"),
        fixture("dep-requirer"),
      ],
      pluginConfig: {
        "object-store-s3": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
        "connector-mcp": { allowInsecureLoopback: true },
      },
      tools: { timeoutMs: 5_000 },
      http: { port: 0, publicUrl: "https://capybara.example.com" },
    },
  );
  const k = await createKernel(config, { env: {} });
  await k.start();
  const accounts = new AccountsService(db);
  const rootId = (
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    })
  ).id;
  const bossId = (await accounts.createLocal({ login: "boss", password: PW, displayName: "B" })).id;
  const memId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" })).id;
  const root = await session(k, "root");
  const boss = await session(k, "boss");
  const mem = await session(k, "mem");
  const orgId = await createOrg(root);
  await db
    .insertInto("memberships")
    .values([
      { org_id: orgId, account_id: bossId, role: "admin" },
      { org_id: orgId, account_id: memId, role: "member" },
    ])
    .execute();
  return {
    k,
    db,
    mcp,
    root,
    rootId,
    boss,
    bossId,
    mem,
    memId,
    orgId,
    async stop() {
      await k.stop();
      await raw.destroy();
      await mcp.stop();
      await rm(pluginsDir, { recursive: true, force: true });
      await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
      pgc = rd = undefined;
      s3 = undefined;
    },
  };
}

/** 清掉目录、安装、申请、组织技能 / 连接器 / 插件启用与审计（保留账号与组织）。 */
export async function resetOrgDirectory(env: OrgEnv): Promise<void> {
  await truncateTables(
    env.db,
    "capybara.app_install_components, capybara.app_installs, capybara.plugin_directory_sources, capybara.directory_requests, capybara.directory_org_grants, capybara.directory_item_versions, capybara.directory_items, capybara.skill_versions, capybara.skills, capybara.connector_tools, capybara.connectors, capybara.plugin_org_configs, capybara.deployment_settings, capybara.audit_events",
  );
  await env.k.storage.deployment().deletePrefix("directory/");
}

const importFile = (req: Req, bytes: Uint8Array) =>
  req({
    method: "POST",
    url: "/api/v1/admin/directory/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });

type Policy = "allow" | "needs_approval" | "disabled";

export async function setPolicy(env: OrgEnv, itemId: string, policy: Policy): Promise<void> {
  const r = await env.root({
    method: "PUT",
    url: `/api/v1/admin/directory/items/${itemId}/policy`,
    payload: { policy },
  });
  expect(r.statusCode).toBe(200);
}

/** 经企业管理员导入一个技能条目，返回条目 id。 */
export async function importSkill(
  env: OrgEnv,
  o: { policy?: Policy; skillName?: string; name?: string; version?: string } = {},
): Promise<string> {
  const r = await importFile(
    env.root,
    await skillTgz({
      ...(o.name !== undefined && { name: o.name }),
      ...(o.version !== undefined && { version: o.version }),
      ...(o.skillName !== undefined && { skillName: o.skillName }),
    }),
  );
  expect(r.statusCode).toBe(201);
  const id = (r.json() as { id: string }).id;
  if (o.policy && o.policy !== "allow") await setPolicy(env, id, o.policy);
  return id;
}

/** 经企业管理员导入一个连接器模板条目（connector-mcp，端点 url 可改，bearer），返回条目 id。 */
export async function importTemplate(
  env: OrgEnv,
  o: { policy?: Policy; template?: unknown; name?: string } = {},
): Promise<string> {
  const r = await importFile(
    env.root,
    await templateTgz({
      ...(o.template !== undefined && { template: o.template }),
      ...(o.name !== undefined && { name: o.name }),
    }),
  );
  expect(r.statusCode).toBe(201);
  const id = (r.json() as { id: string }).id;
  if (o.policy && o.policy !== "allow") await setPolicy(env, id, o.policy);
  return id;
}

/**
 * 真实走一遍：插件包导入为目录条目 → 装到部署（`plugin_installs.directory_item_id` 与来源表）→ 部署上启用并等本副本加载。
 */
export async function importDeployedPlugin(
  env: OrgEnv,
  name: string,
): Promise<{ itemId: string; sha256: string }> {
  const bytes = await pluginTgz({ name });
  const r = await importFile(env.root, bytes);
  expect(r.statusCode, r.body).toBe(201);
  const itemId = (r.json() as { id: string }).id;
  const inst = await env.root({
    method: "POST",
    url: `/api/v1/admin/directory/items/${itemId}/install-deployment`,
    payload: { version: "1.0.0" },
  });
  expect(inst.statusCode, inst.body).toBe(200);
  const en = await env.root({ method: "POST", url: `/api/v1/admin/plugins/${name}/enable` });
  expect(en.statusCode, en.body).toBe(200);
  await waitFor(async () => env.k.host.current(name) !== undefined, 15_000, name);
  return { itemId, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** 直接写一个插件条目（插件已由启动配置加载；组织侧只看条目与策略）。 */
export async function seedPluginItem(
  env: OrgEnv,
  name: string,
  policy: Policy = "allow",
): Promise<string> {
  const id = randomUUID();
  await env.db
    .insertInto("directory_items")
    .values({
      id,
      kind: "plugin",
      name,
      package_name: `@capybara-hq/plugin-${name}`,
      publisher: "capybara",
      description: name,
      latest_version: "0.1.0",
      policy,
    })
    .execute();
  await env.db
    .insertInto("directory_item_versions")
    .values({
      item_id: id,
      version: "0.1.0",
      section: JSON.stringify({ kind: "plugin" }),
      source: "file",
      source_ref: "upload",
      size: 1,
    })
    .execute();
  return id;
}

/**
 * 直接写一个应用条目（模拟 T25 确认后的状态）：app.yaml 与技能文件放进部署存储，版本行带 resolved。
 * 应用含插件 `plugins`、一个连接器模板 `gh`（connector-mcp）、技能 `skills/<skill>`。
 */
export async function seedApp(
  env: OrgEnv,
  o: {
    name?: string;
    plugins?: string[];
    skills?: string[];
    templates?: boolean;
    policy?: Policy;
    /** 标为可选的插件。 */
    optional?: string[];
    /** 插件的版本范围（缺省 ^0.1.0）。 */
    ranges?: Record<string, string>;
    /** 模板 gh 的连接器插件（缺省 connector-mcp）。 */
    templatePlugin?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const name = o.name ?? "crm";
  const plugins = o.plugins ?? ["todo", "example-counter"];
  const skills = o.skills ?? ["pdf-tools"];
  const manifest = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "CRM bundle",
    plugins: plugins.map((p) => ({
      name: p,
      npm: `@capybara-hq/plugin-${p}`,
      version: o.ranges?.[p] ?? "^0.1.0",
      lock: {
        version: (o.ranges?.[p] ?? "^0.1.0").replace(/^\^/, ""),
        integrity: `sha512-${"A".repeat(86)}==`,
      },
      ...(o.optional?.includes(p) && { optional: true }),
    })),
    connectorTemplates:
      o.templates === false
        ? []
        : [
            {
              id: "gh",
              displayName: { zh: "GitHub", en: "GitHub" },
              template: {
                ...templateNoIcon(),
                ...(o.templatePlugin !== undefined && { plugin: o.templatePlugin }),
              },
            },
          ],
    skills: skills.map((s) => ({ path: `skills/${s}` })),
  };
  const files: { path: string; data: Uint8Array }[] = [
    { path: "app.yaml", data: new TextEncoder().encode(stringifyYaml(manifest)) },
    ...skills.flatMap((s) => [
      { path: `skills/${s}/SKILL.md`, data: new TextEncoder().encode(SKILL_MD(s)) },
      { path: `skills/${s}/run.py`, data: new TextEncoder().encode("print(1)\n") },
    ]),
  ];
  const prefix = `directory/${id}/1.0.0/${randomUUID()}/`;
  for (const f of files) {
    await env.k.storage.deployment().put(`${prefix}${f.path}`, f.data, {
      contentType: "application/octet-stream",
      size: f.data.byteLength,
    });
  }
  await env.db
    .insertInto("directory_items")
    .values({
      id,
      kind: "app",
      name,
      package_name: `@acme/app-${name}`,
      publisher: "Acme",
      description: "CRM bundle",
      latest_version: "1.0.0",
      policy: o.policy ?? "allow",
    })
    .execute();
  await env.db
    .insertInto("directory_item_versions")
    .values({
      item_id: id,
      version: "1.0.0",
      section: JSON.stringify({ kind: "app", manifest: "app.yaml" }),
      source: "file",
      source_ref: "upload",
      object_prefix: prefix,
      resolved: JSON.stringify({
        plugins: plugins.map((p) => ({
          name: p,
          sha256: "0".repeat(64),
          range: o.ranges?.[p] ?? "^0.1.0",
          optional: o.optional?.includes(p) === true,
        })),
      }),
      files: JSON.stringify(
        files.map((f) => ({
          path: f.path,
          size: f.data.byteLength,
          sha256: createHash("sha256").update(f.data).digest("hex"),
        })),
      ),
      size: 1000,
    })
    .execute();
  return id;
}

export const install = (
  req: Req,
  env: OrgEnv,
  itemId: string,
  body: Record<string, unknown> = {},
): ReturnType<Req> =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/directory/${itemId}/install`,
    payload: body,
  });

export const requestItem = (
  req: Req,
  env: OrgEnv,
  itemId: string,
  note?: string,
): ReturnType<Req> =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${env.orgId}/directory/${itemId}/requests`,
    payload: note === undefined ? {} : { note },
  });

export async function auditActions(env: OrgEnv): Promise<string[]> {
  const rows = await env.db.selectFrom("audit_events").select("action").orderBy("id").execute();
  return rows.map((r) => r.action);
}

export async function setDeployment(env: OrgEnv, patch: Record<string, unknown>): Promise<void> {
  const r = await env.root({ method: "PUT", url: "/api/v1/admin/settings", payload: patch });
  expect(r.statusCode).toBe(200);
}
