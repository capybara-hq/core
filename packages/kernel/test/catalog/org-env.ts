import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorTemplateSpec } from "@capybara-hq/plugin-sdk";
import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { expect } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createKernel, KERNEL_MIGRATIONS_DIR, type Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { createOrg, PW, type Req, runConfig, session, waitFor } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { mcpTemplate, skillPlugin, templatePlugin } from "./packages.js";

// The core fakes of @capybara-hq/testing stand in for official plugins: an object store, a
// connector extension (kind `fake`), an extension with tools / view / migration (`fake-tools-ui`)
// and a `counter@1` provider (`fake-dep-provider`, version 0.1.0).
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const CONNECTOR = fakeExtensionEntry("fake-connector");
const TOOLS_UI = fakeExtensionEntry("fake-tools-ui");
const DEP_PROVIDER = fakeExtensionEntry("fake-dep-provider");

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

/** The bearer the fake MCP server requires. */
export const MCP_TOKEN = "tok-123";

/** The org catalog test environment: PG + Redis + SeaweedFS + a fake MCP; the kernel loads fake-connector, fake-tools-ui, fake-dep-provider. */
export interface OrgEnv {
  k: Kernel;
  db: KernelSchemaDb;
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
        OBJECT_STORE,
        MODEL_FAKE,
        CONNECTOR,
        TOOLS_UI,
        DEP_PROVIDER,
        fixture("dep-provider"),
        fixture("dep-requirer"),
      ],
      extensionConfig: {
        "fake-object-store": {
          endpoint: s3.endpoint,
          region: s3.region,
          bucket: s3.bucket,
          accessKeyId: s3.accessKey,
          secretAccessKey: s3.secretKey,
          forcePathStyle: true,
        },
        "fake-connector": { allowInsecureLoopback: true },
      },
      tools: { timeoutMs: 5_000 },
      http: { port: 0, publicUrl: "https://capybara.example.com" },
    },
  );
  const k = await createKernel(config, { env: {} });
  await k.start();
  const accounts = accountsFor(db);
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
    "capybara.plugin_install_components, capybara.plugin_installs, capybara.agent_template_versions, capybara.agent_templates, capybara.extension_catalog_sources, capybara.catalog_requests, capybara.catalog_org_grants, capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.skill_versions, capybara.skills, capybara.connector_tools, capybara.connectors, capybara.extension_org_configs, capybara.deployment_settings, capybara.audit_events",
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
 * fake-connector, endpoint url editable, bearer; plugin `name`, default `github-mcp`); returns the
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
 * config, e.g. `fake-tools-ui`), a connector template `gh` (fake-connector, or `templatePlugin`) unless
 * `templates` is false (or the templates `connectors/<id>.json` given as overrides of
 * `mcpTemplate()`), and skills `skills/<skill>` (`skillScripts[skill]` is its `run.py`). `version`
 * defaults to 1.0.0; `addTo` adds the version to that existing item (its latest version is left as
 * it is) instead of creating one; `extensionSha256` is the version's extension package.
 */
export async function seedPlugin(
  env: OrgEnv,
  o: {
    name?: string;
    extension?: boolean;
    skills?: string[];
    templates?: boolean | Record<string, Partial<ConnectorTemplateSpec>>;
    skillScripts?: Record<string, string>;
    extensionSha256?: string;
    policy?: Policy;
    /** The connector extension of template gh (default fake-connector). */
    templatePlugin?: string;
    dependencies?: { name: string; version: string }[];
    version?: string;
    addTo?: string;
    /** Skills whose manifest entry sets `pinned: true` (the suggestion, spec §9.1). */
    pinned?: string[];
    /** The version's `source_format` (default capybara). */
    sourceFormat?: "capybara" | "claude-code";
  } = {},
): Promise<string> {
  const id = o.addTo ?? randomUUID();
  const version = o.version ?? "1.0.0";
  const name = o.name ?? "crm";
  const skills = o.skills ?? ["pdf-tools"];
  const templates: Record<string, Partial<ConnectorTemplateSpec>> = o.templates === false
    ? {}
    : o.templates === true || o.templates === undefined
      ? { gh: {} }
      : o.templates;
  const manifest = {
    schemaVersion: 1,
    name,
    version,
    publisher: "Acme",
    description: "CRM bundle",
    ...(o.dependencies !== undefined && { dependencies: o.dependencies }),
    skills: skills.map((s) => ({
      path: `./skills/${s}`,
      ...(o.pinned?.includes(s) && { pinned: true }),
    })),
    connectorTemplates: Object.keys(templates).map((t) => ({ path: `./connectors/${t}.json` })),
    ...(o.extension && {
      extension: { entry: "./dist/index.mjs", manifest: { name, version } },
    }),
  };
  const files: { path: string; data: Uint8Array }[] = [
    ...skills.flatMap((s) => [
      { path: `skills/${s}/SKILL.md`, data: new TextEncoder().encode(SKILL_MD(s)) },
      {
        path: `skills/${s}/run.py`,
        data: new TextEncoder().encode(o.skillScripts?.[s] ?? "print(1)\n"),
      },
    ]),
    ...Object.entries(templates).map(([t, over]) => ({
      path: `connectors/${t}.json`,
      data: new TextEncoder().encode(
        JSON.stringify({
          displayName: t === "gh" ? { zh: "GitHub", en: "GitHub" } : { zh: t, en: t },
          template: {
            ...mcpTemplate(),
            ...(o.templatePlugin !== undefined && { plugin: o.templatePlugin }),
            ...over,
          },
        }),
      ),
    })),
  ];
  const prefix = files.length > 0 ? `directory/${id}/${version}/${randomUUID()}/` : null;
  for (const f of files) {
    await env.k.storage.deployment().put(`${prefix}${f.path}`, f.data, {
      contentType: "application/octet-stream",
      size: f.data.byteLength,
    });
  }
  if (o.addTo === undefined) {
    await env.db
      .insertInto("catalog_items")
      .values({
        id,
        name,
        package_name: `@acme/plugin-${name}`,
        publisher: "Acme",
        description: "CRM bundle",
        latest_version: version,
        policy: o.policy ?? "allow",
      })
      .execute();
  }
  await env.db
    .insertInto("catalog_item_versions")
    .values({
      item_id: id,
      version,
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
      ...(o.extensionSha256 !== undefined && { extension_sha256: o.extensionSha256 }),
      ...(o.sourceFormat !== undefined && { source_format: o.sourceFormat }),
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
