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
import { mcpTemplate, skillPlugin, templatePlugin } from "./packages.js";

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

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

/** The bearer the fake MCP server requires. */
export const MCP_TOKEN = "tok-123";

/** The org catalog test environment: PG + Redis + SeaweedFS + a fake MCP; the kernel loads connector-mcp, todo, example-counter. */
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
      extensionHost: { dir: pluginsDir },
      extensions: [
        OBJECT_STORE_S3,
        MODEL_FAKE,
        CONNECTOR_MCP,
        TODO,
        EXAMPLE_COUNTER,
        fixture("dep-provider"),
        fixture("dep-requirer"),
      ],
      extensionConfig: {
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

/** Clears the catalog, installs, requests, org skills / connectors / extension enabling and audits (accounts and orgs stay). */
export async function resetOrgCatalog(env: OrgEnv): Promise<void> {
  await truncateTables(
    env.db,
    "capybara.plugin_install_components, capybara.plugin_installs, capybara.extension_catalog_sources, capybara.catalog_requests, capybara.catalog_org_grants, capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.skill_versions, capybara.skills, capybara.connector_tools, capybara.connectors, capybara.extension_org_configs, capybara.deployment_settings, capybara.audit_events",
  );
  await env.k.storage.deployment().deletePrefix("directory/");
}

/** Imports a plugin tgz as the enterprise admin (prepare -> confirm); returns the item id. */
export async function importPlugin(env: OrgEnv, bytes: Uint8Array): Promise<string> {
  const r = await env.root({
    method: "POST",
    url: "/api/v1/admin/catalog/import/file",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes),
  });
  expect(r.statusCode, r.body).toBe(200);
  const c = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/imports/${r.json().stagingId}/confirm`,
    payload: { reviewHash: r.json().review.reviewHash, deployExtension: false },
  });
  expect(c.statusCode, c.body).toBe(201);
  return (c.json() as { item: { id: string } }).item.id;
}

type Policy = "allow" | "needs_approval" | "disabled";

export async function setPolicy(env: OrgEnv, itemId: string, policy: Policy): Promise<void> {
  const r = await env.root({
    method: "PUT",
    url: `/api/v1/admin/catalog/items/${itemId}/policy`,
    payload: { policy },
  });
  expect(r.statusCode).toBe(200);
}

/**
 * Imports a skills-only plugin as the enterprise admin (plugin `name`, default `pdf-tools`, with
 * one skill `skillName`, default the plugin name); returns the item id.
 */
export async function importSkill(
  env: OrgEnv,
  o: { policy?: Policy; skillName?: string; name?: string; version?: string } = {},
): Promise<string> {
  const id = await importPlugin(
    env,
    await skillPlugin(o.name ?? "pdf-tools", {
      ...(o.version !== undefined && { version: o.version }),
      ...(o.skillName !== undefined && { skill: o.skillName }),
    }),
  );
  if (o.policy && o.policy !== "allow") await setPolicy(env, id, o.policy);
  return id;
}

/** The template id of {@link importTemplate}'s plugins (`connectors/github-mcp.json`). */
export const TEMPLATE_ID = "github-mcp";

/**
 * Imports a templates-only plugin as the enterprise admin (template {@link TEMPLATE_ID}:
 * connector-mcp, endpoint url editable, bearer; plugin `name`, default `github-mcp`); returns the
 * item id.
 */
export async function importTemplate(
  env: OrgEnv,
  o: { policy?: Policy; template?: unknown; name?: string } = {},
): Promise<string> {
  const id = await importPlugin(
    env,
    await templatePlugin(
      TEMPLATE_ID,
      (o.template as ReturnType<typeof mcpTemplate> | undefined) ?? mcpTemplate(),
      { ...(o.name !== undefined && { name: o.name }) },
    ),
  );
  if (o.policy && o.policy !== "allow") await setPolicy(env, id, o.policy);
  return id;
}

/**
 * The real path end to end: an extension-only plugin imported into the catalog -> its extension
 * installed on the deployment (`extension_installs.catalog_item_id` and the source table) -> enabled
 * on the deployment, waiting for this replica to load it.
 */
export async function importDeployedPlugin(
  env: OrgEnv,
  name: string,
): Promise<{ itemId: string; sha256: string }> {
  const bytes = await pluginTgz({ manifest: { name }, extension: {} });
  const itemId = await importPlugin(env, bytes);
  const inst = await env.root({
    method: "POST",
    url: `/api/v1/admin/catalog/items/${itemId}/install-deployment`,
    payload: { version: "1.0.0" },
  });
  expect(inst.statusCode, inst.body).toBe(200);
  const en = await env.root({ method: "POST", url: `/api/v1/admin/extensions/${name}/enable` });
  expect(en.statusCode, en.body).toBe(200);
  await waitFor(async () => env.k.host.current(name) !== undefined, 15_000, name);
  return { itemId, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Writes an extension-only plugin item directly (the extension is loaded from the startup config;
 * the org side only reads the item, its manifest and policy).
 */
export async function seedPluginItem(
  env: OrgEnv,
  name: string,
  policy: Policy = "allow",
): Promise<string> {
  return seedPlugin(env, { name, extension: true, skills: [], templates: false, policy });
}

/**
 * Writes a plugin item directly (the state after an import's confirm): the normalized plugin.json in
 * the version row, the skill and template files in deployment storage. The plugin has its own
 * extension when `extension` is true (`name` must then be an extension loaded from the startup
 * config, e.g. `todo`), a connector template `gh` (connector-mcp, or `templatePlugin`) unless
 * `templates` is false, and skills `skills/<skill>`.
 */
export async function seedPlugin(
  env: OrgEnv,
  o: {
    name?: string;
    extension?: boolean;
    skills?: string[];
    templates?: boolean;
    policy?: Policy;
    /** The connector extension of template gh (default connector-mcp). */
    templatePlugin?: string;
    dependencies?: { name: string; version: string }[];
  } = {},
): Promise<string> {
  const id = randomUUID();
  const name = o.name ?? "crm";
  const skills = o.skills ?? ["pdf-tools"];
  const templates = o.templates !== false;
  const manifest = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "CRM bundle",
    ...(o.dependencies !== undefined && { dependencies: o.dependencies }),
    skills: skills.map((s) => ({ path: `./skills/${s}` })),
    connectorTemplates: templates ? [{ path: "./connectors/gh.json" }] : [],
    ...(o.extension && {
      extension: { entry: "./dist/index.mjs", manifest: { name, version: "1.0.0" } },
    }),
  };
  const files: { path: string; data: Uint8Array }[] = [
    ...skills.flatMap((s) => [
      { path: `skills/${s}/SKILL.md`, data: new TextEncoder().encode(SKILL_MD(s)) },
      { path: `skills/${s}/run.py`, data: new TextEncoder().encode("print(1)\n") },
    ]),
    ...(templates
      ? [
          {
            path: "connectors/gh.json",
            data: new TextEncoder().encode(
              JSON.stringify({
                displayName: { zh: "GitHub", en: "GitHub" },
                template: {
                  ...mcpTemplate(),
                  ...(o.templatePlugin !== undefined && { plugin: o.templatePlugin }),
                },
              }),
            ),
          },
        ]
      : []),
  ];
  const prefix = files.length > 0 ? `directory/${id}/1.0.0/${randomUUID()}/` : null;
  for (const f of files) {
    await env.k.storage.deployment().put(`${prefix}${f.path}`, f.data, {
      contentType: "application/octet-stream",
      size: f.data.byteLength,
    });
  }
  await env.db
    .insertInto("catalog_items")
    .values({
      id,
      name,
      package_name: `@acme/plugin-${name}`,
      publisher: "Acme",
      description: "CRM bundle",
      latest_version: "1.0.0",
      policy: o.policy ?? "allow",
    })
    .execute();
  await env.db
    .insertInto("catalog_item_versions")
    .values({
      item_id: id,
      version: "1.0.0",
      manifest: JSON.stringify(manifest),
      source: "file",
      source_ref: "upload",
      object_prefix: prefix,
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
    url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/install`,
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
    url: `/api/v1/orgs/${env.orgId}/catalog/${itemId}/requests`,
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
