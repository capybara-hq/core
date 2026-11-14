import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorTemplateSpec, PluginManifest } from "@capybara-hq/plugin-sdk";
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
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { expect } from "vitest";
import { putTemplateVersionIn } from "../../src/agents/templates.js";
import {
  readCatalogAgentTemplates,
  readCatalogFiles,
  skillOf,
} from "../../src/catalog/catalog-content.js";
import {
  PLUGIN_SCOPE_QUEUE,
  SCOPE_BACKSTOP_DELAY,
  SCOPE_BACKSTOP_JOB,
} from "../../src/catalog/scope-sync.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import type { KernelLogger } from "../../src/log.js";
import type { KernelOverride } from "../../src/overrides.js";
import { packagePath } from "../../src/packages/tgz.js";
import { SkillsService } from "../../src/skills/skills.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { type ExtensionTgzOpts, pluginTgz } from "../helpers/plugin-packages.js";
import {
  createOrg,
  enableConnectorExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { mcpTemplate, skillPlugin, templatePlugin } from "./packages.js";
import { syncPlatformComponents } from "./platform-sync.js";

// The core fakes of @capybara-hq/testing stand in for official plugins: an object store, a
// connector extension (kind `fake`), an extension with tools / view / migration (`fake-tools-ui`)
// and a `counter@1` provider (`fake-dep-provider`, version 0.1.0).
const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const CONNECTOR = fakeExtensionEntry("fake-connector");
const TOOLS_UI = fakeExtensionEntry("fake-tools-ui");
const DEP_PROVIDER = fakeExtensionEntry("fake-dep-provider");

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));

/** The scope sync backstop's delay in these tests: an hour, longer than any test file. */
export const TEST_SCOPE_BACKSTOP_DELAY_MS = 60 * 60_000;

/** The bearer the fake MCP server requires. */
export const MCP_TOKEN = "tok-123";

/** The org catalog test environment: PG + Redis + SeaweedFS + a fake MCP; the kernel loads fake-connector, fake-tools-ui, fake-dep-provider. */
export interface OrgEnv {
  k: TestKernel;
  db: KernelSchemaDb;
  mcp: FakeMcpServer;
  /** 超级管理员（也是组织所有者）。 */
  root: Req;
  rootId: string;
  /** 组织管理员（不是超级管理员）。 */
  boss: Req;
  bossId: string;
  /** 组织成员。 */
  mem: Req;
  memId: string;
  orgId: string;
  stop(): Promise<void>;
}

/**
 * Starts the environment; `overrides` are merged into the kernel config (e.g. `packages` with a
 * fake npm registry, `marketplaces`, `tools`).
 */
export async function startOrgEnv(
  overrides: {
    packages?: Record<string, unknown>;
    marketplaces?: Record<string, unknown>;
    /** Replaces the `tools` config (default `{ timeoutMs: 5_000 }`). */
    tools?: Record<string, unknown>;
    /** The kernel's logger (default: logs discarded). */
    logger?: KernelLogger;
    /** Kernel provider overrides (test seams such as `OUTBOX_DISPATCH_FAILS`). */
    kernelOverrides?: KernelOverride[];
  } = {},
): Promise<OrgEnv> {
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
      ...(overrides.packages !== undefined && { packages: overrides.packages }),
      ...(overrides.marketplaces !== undefined && { marketplaces: overrides.marketplaces }),
      ...(overrides.tools !== undefined && { tools: overrides.tools }),
    },
  );
  const k = await startKernel(config, {
    env: {},
    ...(overrides.logger !== undefined && { logger: overrides.logger }),
    overrides: [
      // a confirmation's scope sync backstop never fires within a test file (ruling R24)
      { provide: SCOPE_BACKSTOP_DELAY, useValue: TEST_SCOPE_BACKSTOP_DELAY_MS },
      ...(overrides.kernelOverrides ?? []),
    ],
  });
  const accounts = accountsFor(db);
  const rootId = (
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      superAdmin: true,
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
      await k.close();
      await raw.destroy();
      await mcp.stop();
      await rm(pluginsDir, { recursive: true, force: true });
      await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
      pgc = rd = undefined;
      s3 = undefined;
    },
  };
}

/**
 * Whether the scope queue has nothing to do: no owed outbox row (one the fast path or the relay
 * has not delivered yet) and no waiting, running or delayed job. A confirmation's backstop
 * (`scope-item-backstop`, due five minutes later, ruling R24) is left out: it only repeats the
 * immediate sync.
 */
export async function scopeQueueIdle(env: OrgEnv): Promise<boolean> {
  const owed = await env.db
    .selectFrom("outbox")
    .select("id")
    .where("queue", "=", PLUGIN_SCOPE_QUEUE)
    .where("job_name", "!=", SCOPE_BACKSTOP_JOB)
    .where("dead_at", "is", null)
    .execute();
  if (owed.length > 0) return false;
  const queue = env.k.app.get<Queue>(getQueueToken(PLUGIN_SCOPE_QUEUE));
  const c = await queue.getJobCounts("waiting", "active", "prioritized");
  if (Object.values(c).some((n) => n > 0)) return false;
  const delayed = await queue.getDelayed();
  return delayed.every((j) => j.name === SCOPE_BACKSTOP_JOB);
}

/** Clears the catalog, installs, requests, org skills / connectors / extension enabling and audits (accounts and orgs stay). */
export async function resetOrgCatalog(env: OrgEnv): Promise<void> {
  // A scope change of the previous test (a share switch, an update) owed a scope sync with its
  // commit. Left running, it holds catalog_items FOR SHARE and then reads the switches while
  // the TRUNCATE below holds the switches and waits for catalog_items: a deadlock PostgreSQL only
  // breaks after deadlock_timeout (1 s), and a sync still queued would run into the next test.
  // A sync still owed (an outbox row not delivered yet) would run into the next test too
  await env.db.deleteFrom("outbox").where("queue", "=", PLUGIN_SCOPE_QUEUE).execute();
  const scope = env.k.app.get<Queue>(getQueueToken(PLUGIN_SCOPE_QUEUE));
  await scope.drain(true);
  await waitFor(async () => (await scope.getActiveCount()) === 0, 30_000, "idle scope syncs");
  // Install records, package bytes and the per-install components go with the catalog, so a test
  // never inherits an extension an earlier test installed. Approval snapshots and name owners stay:
  // config-declared extensions (loaded from the startup config) own rows there, and the platform
  // views read them for those extensions.
  await truncateTables(
    env.db,
    "capybara.plugin_install_components, capybara.plugin_installs, capybara.agent_template_versions, capybara.agent_templates, capybara.extension_catalog_sources, capybara.extension_installs, capybara.extension_packages, capybara.extension_blobs, capybara.catalog_requests, capybara.catalog_org_grants, capybara.catalog_item_org_switches, capybara.catalog_item_scope_orgs, capybara.plugin_import_staging, capybara.catalog_item_versions, capybara.catalog_items, capybara.skill_versions, capybara.skills, capybara.platform_skill_versions, capybara.platform_skills, capybara.platform_agent_template_versions, capybara.platform_agent_templates, capybara.platform_connector_templates, capybara.platform_theme_versions, capybara.platform_themes, capybara.component_scope_orgs, capybara.component_org_switches, capybara.connector_tools, capybara.connectors, capybara.extension_org_configs, capybara.deployment_settings, capybara.audit_events",
  );
  await env.k.app.get(StorageService).deployment().deletePrefix("directory/");
  await env.k.app.get(StorageService).deployment().deletePrefix("platform/");
  // The test plugins' templates name the deployed connector extension; the org has it on
  await enableConnectorExtensions(env.k, env.orgId);
}

/** Imports a plugin tgz as the super admin (prepare -> confirm); returns the item id. */
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
    payload: { reviewHash: r.json().review.reviewHash },
  });
  expect(c.statusCode, c.body).toBe(201);
  return (c.json() as { item: { id: string } }).item.id;
}

type Policy = "allow" | "needs_approval" | "disabled";

/**
 * Sets the old item policy and the disabled flag directly in the database (no scope sync runs, so
 * existing installs stay): the org side's checks of a disabled item, and the requests that still
 * read `needs_approval`. The admin route (`PUT items/:id/disabled`) is covered by
 * admin-scope.test.ts.
 */
export async function setPolicy(env: OrgEnv, itemId: string, policy: Policy): Promise<void> {
  await env.db
    .updateTable("catalog_items")
    .set({ policy, disabled: policy === "disabled" })
    .where("id", "=", itemId)
    .execute();
}

/** Sets an item's scope (and, for `named`, the orgs it lists) directly in the database. */
export async function setScope(
  env: OrgEnv,
  itemId: string,
  scope: "all" | "optional" | "named",
  orgs: string[] = [],
): Promise<void> {
  // a scope change bumps scope_version, as the service's does: the sync job id is per version, so an
  // enqueue after this never folds into a job of the old scope still running (BullMQ dedupes by id)
  await env.db
    .updateTable("catalog_items")
    .set({ scope, scope_version: sql<number>`scope_version + 1` })
    .where("id", "=", itemId)
    .execute();
  await env.db.deleteFrom("catalog_item_scope_orgs").where("item_id", "=", itemId).execute();
  if (orgs.length > 0) {
    await env.db
      .insertInto("catalog_item_scope_orgs")
      .values(orgs.map((org_id) => ({ item_id: itemId, org_id })))
      .execute();
  }
}

/** Marks an item builtin directly in the database (a required bootstrap plugin: scope all). */
export async function setBuiltin(env: OrgEnv, itemId: string): Promise<void> {
  await env.db
    .updateTable("catalog_items")
    .set({ builtin: true, scope: "all" })
    .where("id", "=", itemId)
    .execute();
}

/**
 * Imports a skills-only plugin as the super admin (plugin `name`, default `pdf-tools`, with
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
 * Imports a templates-only plugin as the super admin (template {@link TEMPLATE_ID}:
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
 * The real path end to end: an extension-only plugin imported into the catalog, whose confirm
 * installs its extension on the deployment (`extension_installs.catalog_item_id` and the source
 * table) and enables it; waits for this replica to load it. `extension`: {@link pluginTgz}'s.
 */
export async function importDeployedPlugin(
  env: OrgEnv,
  name: string,
  extension: ExtensionTgzOpts = {},
): Promise<{ itemId: string; sha256: string }> {
  const bytes = await pluginTgz({ manifest: { name }, extension });
  const itemId = await importPlugin(env, bytes);
  await waitFor(async () => env.k.app.get(ExtensionHost).current(name) !== undefined, 15_000, name);
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
    /** Templates whose file says `"defaultEnabled": false`. */
    defaultOff?: string[];
    skillScripts?: Record<string, string>;
    extensionSha256?: string;
    policy?: Policy;
    /** The connector extension of template gh (default fake-connector). */
    templatePlugin?: string;
    dependencies?: { name: string; version: string }[];
    version?: string;
    addTo?: string;
    /**
     * Skills whose stored manifest entry still has `pinned: true`, the suggestion removed with
     * skills default-on (stored manifests are history and keep it).
     */
    legacyPinned?: string[];
    /** The version's `source_format` (default capybara). */
    sourceFormat?: "capybara" | "claude-code";
    /**
     * Write the new item's platform components, as an import's confirm does (default true; only
     * for a new item, `addTo` never does).
     */
    platform?: boolean;
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
      ...(o.legacyPinned?.includes(s) && { pinned: true }),
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
          ...(o.defaultOff?.includes(t) && { defaultEnabled: false }),
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
    await env.k.app.get(StorageService).deployment().put(`${prefix}${f.path}`, f.data, {
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
        disabled: o.policy === "disabled",
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
  if (o.addTo === undefined && o.platform !== false) {
    await syncPlatformComponents(env.k.app, id, version);
  }
  return id;
}

/**
 * The org copies an install made before plugin scope phase 2 (installs no longer write them): the
 * installed version's skills and agent templates as org rows with the item's provenance, recorded
 * in the org's live install of `itemId` (created, or a version added to an existing one). For the
 * tests of what still handles such copies (per-org upgrades, uninstalls, the migration).
 */
export async function legacyCopies(
  env: OrgEnv,
  orgId: string,
  itemId: string,
  actor: string | null = env.rootId,
): Promise<void> {
  const a = await env.db
    .selectFrom("plugin_installs as a")
    .innerJoin("catalog_items as i", "i.id", "a.item_id")
    .select(["a.id", "a.version", "i.name"])
    .where("a.org_id", "=", orgId)
    .where("a.item_id", "=", itemId)
    .where("a.status", "=", "installed")
    .executeTakeFirstOrThrow();
  const v = await env.db
    .selectFrom("catalog_item_versions")
    .select(["manifest", "object_prefix", "files", "version", "source_format"])
    .where("item_id", "=", itemId)
    .where("version", "=", a.version)
    .executeTakeFirstOrThrow();
  const storage = env.k.app.get(StorageService);
  const record = (c: {
    kind: "skill" | "agent_template";
    ref: string;
    created: boolean;
    version: number | null;
  }) =>
    env.db
      .insertInto("plugin_install_components")
      .values({
        install_id: a.id,
        kind: c.kind,
        ref: c.ref,
        created: c.created,
        skill_version: c.created ? null : c.version,
      })
      .onConflict((oc) => oc.columns(["install_id", "kind", "ref"]).doNothing())
      .execute();
  for (const t of await readCatalogAgentTemplates(storage, v)) {
    const r = await putTemplateVersionIn(
      env.db,
      {
        orgId,
        plugin: a.name,
        catalogItemId: itemId,
        catalogVersion: a.version,
        sourceFormat: v.source_format,
      },
      t.template,
    );
    await record({
      kind: "agent_template",
      ref: r.id,
      created: r.created,
      version: r.changed ? r.version : null,
    });
  }
  const manifest = v.manifest as PluginManifest;
  for (const sk of manifest.skills ?? []) {
    const files = await readCatalogFiles(storage, v.object_prefix, v.files, packagePath(sk.path));
    const r = await env.k.app.get(SkillsService).createVersionFromFiles(
      orgId,
      actor,
      { ...skillOf(files), files },
      {
        catalog: {
          itemId,
          version: a.version,
          format: v.source_format,
        },
      },
    );
    await record({ kind: "skill", ref: r.skill.id, created: r.created, version: r.version });
  }
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

export async function auditActions(env: OrgEnv): Promise<string[]> {
  const rows = await env.db.selectFrom("audit_events").select("action").orderBy("id").execute();
  return rows.map((r) => r.action);
}

export async function setDeployment(env: OrgEnv, patch: Record<string, unknown>): Promise<void> {
  const r = await env.root({ method: "PUT", url: "/api/v1/admin/settings", payload: patch });
  expect(r.statusCode).toBe(200);
}
