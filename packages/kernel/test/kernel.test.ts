import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConfigSource } from "../src/config/load.js";
import {
  type KernelConfig,
  KernelConfigSchema,
  MARKETPLACE_OFFICIAL_URL_DEFAULT,
} from "../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../src/db/kernel-schema.js";
import { migrate } from "../src/db/migrator.js";
import { createDb } from "../src/db/pool.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { KernelConfigService } from "../src/infra/config/kernel-config.service.js";
import { KERNEL_ROOT_LOGGER } from "../src/infra/tokens.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA, migrateAll } from "../src/kernel.js";
import { createLogger, type KernelLogger } from "../src/log.js";
import { accountsFor } from "./helpers/identity.js";
import { MODEL_FAKE } from "./helpers/model-plugins.js";
import {
  buildKernel,
  createAgent,
  createConv,
  createOrgWithProviders,
  enableConnectorExtensions,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  type TestKernelOptions,
  waitFor,
  waitForTerminal,
} from "./helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
const kernels: TestKernel[] = [];
const masterKey = Buffer.alloc(32, 7).toString("base64");
const fx = (n: string) =>
  fileURLToPath(new URL(`./fixtures/plugins/${n}/index.ts`, import.meta.url));

const raw = (over: Record<string, unknown> = {}, redisUrl = rd.url): Record<string, unknown> => ({
  db: { url: pgc.url, poolMax: 3 },
  redis: { url: redisUrl },
  masterKey,
  marketplaces: { official: { enabled: false } },
  http: { port: 0 },
  extensionPermissions: { autoApprove: true },
  ...over,
});
const cfg = (over: Record<string, unknown> = {}, redisUrl?: string): KernelConfig =>
  KernelConfigSchema.parse(raw(over, redisUrl));

/** 捕获日志行的 logger。 */
function capture(level = "info") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(level, { write: (l) => lines.push(JSON.parse(l)) });
  return { logger, lines };
}

/** 可手动推送变更的假配置来源。 */
function manualSource() {
  let push: ((raw: unknown) => void) | undefined;
  let stopped = false;
  const source: ConfigSource = {
    load: async () => ({}),
    watch(onChange) {
      push = onChange;
      return () => {
        stopped = true;
      };
    },
  };
  return {
    source,
    push: (r: unknown) => push?.(r),
    get stopped() {
      return stopped;
    },
  };
}

async function kernel(config: KernelConfig, opts?: TestKernelOptions) {
  const k = await buildKernel(config, {
    env: {},
    logger: createLogger("info", { write: () => {} }),
    ...opts,
  });
  kernels.push(k);
  return k;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  // Apply the kernel migrations once here: otherwise the first test to start a kernel pays for
  // the whole migration run inside its 5 s budget. "start runs the kernel migrations" checks
  // that on a database of its own.
  await migrateAll(cfg());
});
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("HTTP 健康检查", () => {
  it("/healthz 200；/readyz 200 且标出 pg / redis 正常，且不泄漏连接串", async () => {
    const k = await kernel(cfg());
    await k.start();
    const h = await k.http.inject({ method: "GET", url: "/healthz" });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ ok: true });
    const r = await k.http.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    const text = r.body;
    expect(JSON.parse(text)).toMatchObject({ pg: "ok", redis: "ok" });
    expect(text).not.toContain(pgc.url);
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("redis://");
  });

  // Applying every kernel migration to an empty database is this test's subject; it takes a few
  // seconds alone, so it relies on the integration project's bound rather than its own.
  it("start runs the kernel migrations (capybara schema)", async () => {
    const fresh = await startTestPostgres();
    const c = new pg.Client({ connectionString: fresh.url });
    try {
      const k = await kernel(cfg({ db: { url: fresh.url, poolMax: 3 } }));
      await k.start();
      await c.connect();
      const r = await c.query("select name from capybara._migrations order by name");
      expect(r.rows.map((x) => x.name)).toContain("0001_init.sql");
      await k.close();
    } finally {
      await c.end().catch(() => {});
      await fresh.stop();
    }
  });

  it("关闭 Redis 容器后 /readyz 503，body 标出 redis", async () => {
    const own = await startTestRedis();
    const k = await buildKernel(cfg({}, own.url), {
      env: {},
      logger: createLogger("error", { write: () => {} }),
    });
    try {
      await k.start();
      expect((await k.http.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      await own.stop();
      const r = await k.http.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ pg: "ok", redis: "error" });
    } finally {
      await k.close();
    }
  });

  it("stop() 后 /readyz 立即 503", async () => {
    const k = await kernel(cfg());
    await k.start();
    expect((await k.http.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    const stopping = k.close();
    const r = await k.http.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    await stopping;
    // 停机完成后 HTTP 应用已关闭，不再接受请求（进程内注入同样拒绝）
    await expect(k.http.inject({ method: "GET", url: "/readyz" })).rejects.toThrow();
    await k.close(); // 幂等
  });
});

describe("插件路由", () => {
  it("挂在 /plugins/<name>/* 下，直接访问插件路径 404", async () => {
    const k = await kernel(cfg({ extensions: [fx("fixture")] }));
    await k.start();
    const r = await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hello");
    for (const url of ["/hello", "/plugins/fixture/nope"]) {
      const res = await k.http.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code, url).toBe("not_found");
    }
  });
});

describe("启动日志", () => {
  it("Nest's route mapping lines are logged at info with Nest's context, as in octok", async () => {
    const { logger, lines } = capture("info");
    const k = await kernel(cfg(), { logger });
    await k.start();
    expect(lines.some((l) => l.msg === "kernel started")).toBe(true);
    const mapped = lines.filter((l) => String(l.msg).includes("Mapped {/api/v1/me, GET} route"));
    expect(mapped).toEqual([expect.objectContaining({ level: "info", context: "RouterExplorer" })]);
  });
});

describe("配置热更新", () => {
  it("log.level 热生效；http.port 变化不生效并 warn；非法配置保持原配置", async () => {
    const { logger, lines } = capture("info");
    const src = manualSource();
    const k = await kernel(cfg(), { source: src.source, logger });
    await k.start();
    expect(k.app.get<KernelLogger>(KERNEL_ROOT_LOGGER).level).toBe("info");

    src.push(raw({ log: { level: "debug" } }));
    expect(k.app.get<KernelLogger>(KERNEL_ROOT_LOGGER).level).toBe("debug");
    expect(k.app.get(KernelConfigService).get().log.level).toBe("debug");

    src.push(raw({ log: { level: "debug" }, http: { port: 9999 } }));
    expect(k.app.get(KernelConfigService).get().http.port).toBe(0);
    const warn = lines.find((l) => l.level === "warn" && JSON.stringify(l).includes("http.port"));
    expect(warn).toBeDefined();
    expect(JSON.stringify(lines)).not.toContain(pgc.url);

    const before = k.app.get(KernelConfigService).get();
    src.push({ ...raw(), masterKey: "not-a-key", log: { level: "error" } });
    expect(k.app.get(KernelConfigService).get()).toEqual(before);
    expect(k.app.get<KernelLogger>(KERNEL_ROOT_LOGGER).level).toBe("debug");
    expect(lines.some((l) => l.level === "error" && JSON.stringify(l).includes("masterKey"))).toBe(
      true,
    );

    await k.close();
    expect(src.stopped).toBe(true);
  });
});

describe("角色", () => {
  it("roles: [worker] 时只暴露健康端点（不转发插件路由），队列 handler 能执行", async () => {
    const port = await freePort();
    const k = await kernel(cfg({ roles: ["worker"], http: { port }, extensions: [fx("jobber")] }));
    await k.start();
    expect(k.port).toBe(port);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/plugins/jobber/x`)).status).toBe(404);
    const r = new Redis(rd.url);
    try {
      await vi.waitFor(
        async () => {
          expect(await r.get("cap:jobber:kv:done")).toBe(JSON.stringify({ n: 1, replica: null }));
        },
        { timeout: 5_000 },
      );
    } finally {
      r.disconnect();
    }
  });

  it("roles 含 api 时监听端口", async () => {
    const k = await kernel(cfg({ roles: ["api"] }));
    await k.start();
    const port = k.port as number;
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    await k.close();
    expect(k.port).toBeUndefined();
    expect(await canConnect(port)).toBe(false);
  });
});

describe("插件权限待批准（autoApprove 关闭）", () => {
  it("内核照常启动；待批准插件不加载、路由不挂载，host.pending() 列出；migrateAll 跳过并报告", async () => {
    const pending: string[] = [];
    const r = await migrateAll(
      cfg({ extensions: [fx("perm-a")], extensionPermissions: { autoApprove: false } }),
      { onPending: (p) => pending.push(...p.map((x) => x.plugin)) },
    );
    expect(r.map((x) => x.schema)).toEqual(["capybara"]);
    expect(pending).toEqual(["perm-a"]);
    // fixture 可能已被本文件其他用例自动批准：删掉其快照，使它同样待批准（它有 GET /hello 路由）
    const c = new pg.Client({ connectionString: pgc.url });
    await c.connect();
    try {
      await c.query("DELETE FROM capybara.extension_permission_snapshots WHERE plugin = 'fixture'");
    } finally {
      await c.end();
    }
    const k = await kernel(
      cfg({
        extensions: [fx("perm-a"), fx("fixture")],
        extensionPermissions: { autoApprove: false },
      }),
    );
    await k.start();
    expect(k.app.get(ExtensionHost).manifests()).toEqual([]);
    expect(
      k.app
        .get(ExtensionHost)
        .pending()
        .map((p) => [p.plugin, p.reason]),
    ).toEqual([
      ["perm-a", "new"],
      ["fixture", "new"],
    ]);
    // A config-declared extension pending approval belongs to the deployment but is not active on this replica: the route gate answers 503 extension.unavailable; a completely unknown name 404
    const res = await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("extension.unavailable");
    const unknown = await k.http.inject({ method: "GET", url: "/plugins/nobody/hello" });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("migrateAll", () => {
  it("跑内核与已配置插件的迁移，不调用 setup", async () => {
    // throws 的 setup 会抛错：若 migrateAll 调用了 setup，这里就会失败
    const r = await migrateAll(cfg({ extensions: [fx("fixture"), fx("throws")] }));
    expect(r.map((x) => x.schema)).toEqual(["capybara", "plugin_fixture"]);
    const c = new pg.Client({ connectionString: pgc.url });
    await c.connect();
    try {
      const n = await c.query("select count(*)::int as n from plugin_fixture._migrations");
      expect(n.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });
});

// The official marketplace is on by default (spec §5.5) and lives on the internet. Test kernels must
// never reach it: every config a test builds sets `marketplaces.official.enabled: false`, unless the
// test is about it and points it at a fake.
const URLS = { pg: "postgres://u:p@localhost/db", redis: "redis://localhost:6379" };

describe("runConfig", () => {
  it("keeps the official marketplace off", () => {
    expect(runConfig(URLS).marketplaces.official.enabled).toBe(false);
  });

  it("keeps it off when a test passes other marketplace settings", () => {
    const c = runConfig(URLS, { marketplaces: { allowInsecureLoopback: true } });
    expect(c.marketplaces.official.enabled).toBe(false);
    expect(c.marketplaces.allowInsecureLoopback).toBe(true);
  });

  it("a test about the official marketplace turns it on explicitly", () => {
    const url = "https://example.com/marketplace.json";
    const c = runConfig(URLS, { marketplaces: { official: { enabled: true, url } } });
    expect(c.marketplaces.official).toMatchObject({ enabled: true, url });
  });
});

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("kernels started by tests", () => {
  it("every file that creates a kernel sets the official marketplace or uses a test config helper", () => {
    const roots = [
      "packages/kernel/test",
      "packages/testing/src",
      "packages/testing/test",
      "apps/capybara/test",
    ];
    const offenders = roots
      .flatMap((r) => walk(join(REPO, r)))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        // Creates a kernel itself, or parses its own config and starts it through a helper.
        const starts =
          /\b(?:create|build|start)KernelApp\(/.test(text) ||
          (/KernelConfigSchema\.parse\(/.test(text) &&
            /\b(?:start(?:Test)?|build)Kernel\(/.test(text));
        return (
          starts &&
          !/official:\s*\{\s*enabled:/.test(text) &&
          !/\b(?:testKernelConfig|runConfig)\(/.test(text)
        );
      })
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

describe("startKernel", () => {
  const raw = {
    db: { url: URLS.pg },
    redis: { url: URLS.redis },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  };

  it("refuses a config that would reach the real official marketplace, before starting anything", async () => {
    const config = KernelConfigSchema.parse(raw);
    expect(config.marketplaces.official).toMatchObject({
      enabled: true,
      url: MARKETPLACE_OFFICIAL_URL_DEFAULT,
    });
    await expect(startKernel(config)).rejects.toThrow(/official marketplace/);
  });
});

/**
 * Release-candidate data after the upgrade, on one kernel with the fake connector and a fake MCP
 * server, on containers of its own (the other suites' worker kernels stay up until the file ends
 * and would take its runs): a stored version with the pre-D17 `{kind:"app", appId}` form, and the
 * rc tool keys migrations 0063 / 0139 rewrite.
 */
describe("release-candidate data after the upgrade", () => {
  const CONNECTOR = fakeExtensionEntry("fake-connector");
  let pgc: TestContainer;
  let rd: TestContainer;
  let k: TestKernel;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
  let mcp: FakeMcpServer;

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    mcp = await startFakeMcpServer({
      tools: [
        {
          name: "search",
          description: "Search documents",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: true },
          handler: ({ args }) => ({ content: [{ type: "text", text: `hits for ${args.q}` }] }),
        },
      ],
    });
    k = await startKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          extensions: [MODEL_FAKE, CONNECTOR],
          extensionConfig: { "fake-connector": { allowInsecureLoopback: true } },
          roles: ["api", "worker"],
        },
      ),
    );
    raw = createDb(pgc.url, 5);
    db = kernelDb(raw);
  });

  afterAll(async () => {
    await k?.close();
    await mcp?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  describe("改名后的路由与旧 agent 版本", () => {
    let req: Req;
    let orgId: string;

    beforeAll(async () => {
      await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
      req = await session(k, "owner");
      orgId = await createOrgWithProviders(k, req);
      await enableConnectorExtensions(k, orgId);
    });

    async function install(slug: string): Promise<string> {
      const res = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors`,
        payload: {
          name: `Docs ${slug}`,
          slug,
          connector: "fake",
          endpoint: { url: mcp.url },
          auth: { type: "none" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { connector: { id: string } }).connector.id;
    }

    it("a stored version with {kind:'app', appId}: reads as nothing turned off, runs, the tool key is unchanged", async () => {
      const id = await install("kb");
      const created = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: {
          definition: {
            name: "Helper",
            instructions: "Be helpful.",
            model: { provider: "model-fake", model: "fake-1" },
          },
          visibility: "org",
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const agentId = (created.json() as { agent: { id: string } }).agent.id;
      const stored = await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow();

      // 模拟改名前存下的版本：直接把旧形写回库
      await db
        .updateTable("agent_versions")
        .set({
          definition: JSON.stringify({
            ...(stored.definition as Record<string, unknown>),
            tools: [{ kind: "app", appId: id, tools: "all" }],
          }),
        })
        .where("agent_id", "=", agentId)
        .execute();
      const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
      expect(got.statusCode, got.body).toBe(200);
      // an enabled list from before tools were on by default reads as nothing turned off
      const read = (got.json() as { agent: { definition: Record<string, unknown> } }).agent
        .definition;
      expect(read.tools).toBeUndefined();
      expect(read.disabledTools).toEqual([]);

      const convId = await createConv(req, orgId, agentId);
      await postMessage(req, orgId, convId, 'tool:mcp__kb__search:{"q":"x"}');
      await waitForTerminal(db, convId, 1, 20_000);
      const results = (await eventsOf(db, convId)).filter((e) => e.type === "tool_result");
      expect(results.map((e) => e.payload)).toMatchObject([
        { toolKey: "mcp__kb__search", content: "hits for x", isError: false },
      ]);
    });
  });

  /**
   * Tool naming spec §8: release-candidate data after the upgrade. Mutable state (grants, pending
   * approvals and questions) is rewritten by migration 0063; agent versions and templates by
   * migration 0139 (no compatibility before 0.1.0: the kernel reads only current keys), which also
   * deletes the grants 0063 could not map. Saving an old key is refused.
   */
  const MIGRATION = "0063_tool_keys_claude_code.sql";
  const RETIRE = "0139_retire_legacy_forms.sql";

  describe("release-candidate tool keys in stored data", () => {
    let req: Req;
    let ownerId: string;
    let orgA: string;
    let orgB: string;
    let docsId: string;

    beforeAll(async () => {
      ownerId = (
        await accountsFor(db).createLocal({ login: "legacy", password: PW, displayName: "O" })
      ).id;
      req = await session(k, "legacy");
      orgA = await createOrgWithProviders(k, req, "A");
      orgB = await createOrgWithProviders(k, req, "B");
      await enableConnectorExtensions(k, orgA);
      await enableConnectorExtensions(k, orgB);
      docsId = await install(orgA, "docs");
      await install(orgB, "todo");
      // the deployment has an extension named `todo` (an rc key `todo__write` was its tool)
      await db
        .insertInto("extension_name_owners")
        .values({ name: "todo", package_name: "@example/plugin-todo" })
        .execute();
    });

    async function install(orgId: string, slug: string): Promise<string> {
      const res = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors`,
        payload: {
          name: `Docs ${slug}`,
          slug,
          connector: "fake",
          endpoint: { url: mcp.url },
          auth: { type: "none" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { connector: { id: string } }).connector.id;
    }

    /**
     * Runs migration `name` again, as on a database that has the rc rows and not the migration. The
     * migrator refuses a migration numbered below an applied one, so the later migrations' records
     * are set aside while it runs (from a directory that ends at `name`) and put back afterwards.
     */
    async function rerunMigration(name = MIGRATION): Promise<string[]> {
      await sql`delete from capybara._migrations where name = ${name}`.execute(raw);
      const later = await sql<{ name: string; checksum: string; applied_at: Date }>`
        select name, checksum, applied_at from capybara._migrations where name > ${name}`.execute(
        raw,
      );
      await sql`delete from capybara._migrations where name > ${name}`.execute(raw);
      const upTo = mkdtempSync(join(tmpdir(), "cap-mig-rerun-"));
      try {
        for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
          if (f.endsWith(".sql") && f <= name) {
            copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(upTo, f));
          }
        }
        return (await migrate(pgc.url, { schema: KERNEL_SCHEMA, dir: upTo })).applied;
      } finally {
        for (const r of later.rows) {
          await sql`insert into capybara._migrations (name, checksum, applied_at)
            values (${r.name}, ${r.checksum}, ${r.applied_at})`.execute(raw);
        }
        rmSync(upTo, { recursive: true, force: true });
      }
    }

    it("migration 0063 rewrites grants, pending approvals and questions; 0139 deletes the grants it could not map", async () => {
      const agentA = await createAgent(req, orgA);
      const agentB = await createAgent(req, orgB);
      const conv = await createConv(req, orgA, agentA);
      await postMessage(req, orgA, conv, "hello");
      await waitForTerminal(db, conv, 1, 20_000);
      const runId = (await runsOf(db, conv))[0]?.id as string;

      const grant = (
        orgId: string,
        agentId: string,
        toolKey: string,
        connectorId: string | null,
      ) => ({
        org_id: orgId,
        account_id: ownerId,
        agent_id: agentId,
        tool_key: toolKey,
        spec_hash: "h",
        connector_id: connectorId,
      });
      await db
        .insertInto("tool_grants")
        .values([
          grant(orgA, agentA, "sandbox_bash", null),
          grant(orgA, agentA, "docs__search", docsId),
          grant(orgA, agentA, "todo__write", null),
          grant(orgA, agentA, "nope__thing", null),
          grant(orgA, agentA, "mcp__docs__other", docsId),
          grant(orgB, agentB, "todo__x", null),
        ])
        .execute();
      await db
        .insertInto("conversation_tool_grants")
        .values([
          { conversation_id: conv, tool_key: "sandbox_read", spec_hash: "h", connector_id: null },
          // no connector id recorded: the slug of the conversation's org decides
          { conversation_id: conv, tool_key: "docs__search", spec_hash: "h", connector_id: null },
        ])
        .execute();
      const approval = (callId: string, toolKey: string, status: "pending" | "approved") => ({
        id: randomUUID(),
        org_id: orgA,
        conversation_id: conv,
        run_id: runId,
        call_id: callId,
        tool_key: toolKey,
        input: JSON.stringify({ path: "/a.txt" }),
        requested_for: ownerId,
        approver_role: null,
        status,
        expires_at: new Date(Date.now() + 3_600_000),
        spec_hash: "h",
        connector_id: null,
      });
      await db
        .insertInto("approvals")
        .values([
          approval("c1", "sandbox_edit", "pending"),
          approval("c2", "sandbox_bash", "approved"),
        ])
        .execute();
      const question = (callId: string, toolKey: string, status: "pending" | "answered") => ({
        id: randomUUID(),
        org_id: orgA,
        conversation_id: conv,
        run_id: runId,
        call_id: callId,
        spec: JSON.stringify({ form: {}, state: null, toolKey, step: 1 }),
        status,
        answer: null,
        answered_by: null,
        expires_at: new Date(Date.now() + 3_600_000),
      });
      await db
        .insertInto("questions")
        .values([question("q1", "docs__search", "pending"), question("q2", "ask_user", "answered")])
        .execute();

      expect(await rerunMigration()).toEqual([MIGRATION]);

      const grants = async () =>
        (
          await db
            .selectFrom("tool_grants")
            .select(["org_id", "tool_key"])
            .where("org_id", "in", [orgA, orgB])
            .orderBy("org_id")
            .orderBy("tool_key")
            .execute()
        ).map((r) => `${r.org_id === orgA ? "A" : "B"}:${r.tool_key}`);
      const expected = [
        "A:Bash",
        "A:mcp__docs__other",
        "A:mcp__docs__search",
        "A:nope__thing",
        "A:plugin__todo__write",
        "B:todo__x",
      ].sort();
      expect((await grants()).sort()).toEqual(expected);
      const convGrants = async () =>
        (
          await db
            .selectFrom("conversation_tool_grants")
            .select("tool_key")
            .where("conversation_id", "=", conv)
            .execute()
        )
          .map((r) => r.tool_key)
          .sort();
      expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);
      const approvals = await db
        .selectFrom("approvals")
        .select(["call_id", "tool_key"])
        .where("conversation_id", "=", conv)
        .orderBy("call_id")
        .execute();
      // decided approvals are history and stay
      expect(approvals).toEqual([
        { call_id: "c1", tool_key: "Edit" },
        { call_id: "c2", tool_key: "sandbox_bash" },
      ]);
      const questions = await db
        .selectFrom("questions")
        .select(["call_id", "spec"])
        .where("conversation_id", "=", conv)
        .orderBy("call_id")
        .execute();
      expect(questions.map((q) => [q.call_id, (q.spec as { toolKey: string }).toolKey])).toEqual([
        ["q1", "mcp__docs__search"],
        ["q2", "ask_user"],
      ]);

      // a pending approval for sandbox_edit shows Edit in the inbox
      const list = await req({
        method: "GET",
        url: `/api/v1/orgs/${orgA}/approvals?status=pending`,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(
        (list.json() as { approvals: { callId: string; toolKey: string }[] }).approvals.map((a) => [
          a.callId,
          a.toolKey,
        ]),
      ).toEqual([["c1", "Edit"]]);

      // idempotent: a second run changes nothing
      expect(await rerunMigration()).toEqual([MIGRATION]);
      expect((await grants()).sort()).toEqual(expected);
      expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);

      // 0139: the rows 0063 could not map (nope__thing, the ambiguous todo__x) name no tool and go
      expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
      expect((await grants()).sort()).toEqual(
        expected.filter((g) => g !== "A:nope__thing" && g !== "B:todo__x"),
      );
      expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);
    });

    it("migration 0139 rewrites rc keys in agent versions and templates; the agent runs with them", async () => {
      const created = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgA}/agents`,
        payload: {
          definition: {
            name: "Legacy",
            instructions: "Be helpful.",
            model: { provider: "model-fake", model: "fake-1" },
          },
          visibility: "org",
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const agentId = (created.json() as { agent: { id: string } }).agent.id;
      const stored = await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow();
      // an rc version: old builtin and connector policy keys, an ambiguous key (`todo` is both an
      // extension of the deployment and, in org B only, a connector: here only an extension), the
      // removed skill_write, and an inline template
      const current = stored.definition as Record<string, unknown>;
      await db
        .updateTable("agent_versions")
        .set({
          definition: JSON.stringify({
            ...current,
            toolPolicies: {
              sandbox_bash: "deny",
              docs__search: "ask",
              todo__write: "ask",
              skill_write: "deny",
              Read: "ask",
            },
            subagents: {
              inline: [
                {
                  name: "reader",
                  description: "Reads files",
                  instructions: "Read what you are asked to.",
                  tools: ["sandbox_read", "Read", "nope__x"],
                  disallowedTools: ["docs__search"],
                },
              ],
            },
          }),
        })
        .where("agent_id", "=", agentId)
        .execute();
      // an org template with rc keys
      const tpl = { id: randomUUID() };
      await db
        .insertInto("agent_templates")
        .values({ id: tpl.id, org_id: orgA, name: "rc-template", current_version: 1 } as never)
        .execute();
      await db
        .insertInto("agent_template_versions")
        .values({
          template_id: tpl.id,
          version: 1,
          definition: JSON.stringify({
            name: "rc-template",
            description: "d",
            instructions: "i",
            tools: ["sandbox_read", "docs__search"],
            toolPolicies: { ask_user: "ask" },
            subagents: {
              inline: [
                {
                  name: "helper",
                  description: "d",
                  instructions: "i",
                  tools: ["sandbox_grep"],
                  disallowedTools: ["docs__search"],
                  toolPolicies: { sandbox_bash: "deny" },
                },
              ],
            },
          }),
        } as never)
        .execute();
      // a platform template (no org: only extension names resolve) with an inline sub-agent
      const ptpl = { id: randomUUID() };
      await db
        .insertInto("platform_agent_templates")
        .values({ id: ptpl.id, name: "rc-platform-template", current_version: 1 } as never)
        .execute();
      await db
        .insertInto("platform_agent_template_versions")
        .values({
          template_id: ptpl.id,
          version: 1,
          definition: JSON.stringify({
            name: "rc-platform-template",
            description: "d",
            instructions: "i",
            tools: ["sandbox_read", "docs__search"],
            subagents: {
              inline: [
                {
                  name: "helper",
                  description: "d",
                  instructions: "i",
                  tools: ["sandbox_glob", "todo__write"],
                  toolPolicies: { ask_user: "deny", todo__write: "ask" },
                },
              ],
            },
          }),
        } as never)
        .execute();

      expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
      const after = await db
        .selectFrom("agent_versions")
        .select("definition")
        .where("agent_id", "=", agentId)
        .executeTakeFirstOrThrow();
      const def = after.definition as Record<string, unknown>;
      expect(def.toolPolicies).toEqual({
        Bash: "deny",
        mcp__docs__search: "ask",
        plugin__todo__write: "ask",
        Read: "ask",
      });
      expect(def.subagents).toMatchObject({
        inline: [
          { name: "reader", tools: ["Read", "nope__x"], disallowedTools: ["mcp__docs__search"] },
        ],
      });
      expect(def.instructions).toBe(current.instructions);
      const tplAfter = await db
        .selectFrom("agent_template_versions")
        .select("definition")
        .where("template_id", "=", tpl.id)
        .executeTakeFirstOrThrow();
      expect(tplAfter.definition).toMatchObject({
        tools: ["Read", "mcp__docs__search"],
        toolPolicies: { AskUserQuestion: "ask" },
        subagents: {
          inline: [
            {
              name: "helper",
              tools: ["Grep"],
              disallowedTools: ["mcp__docs__search"],
              toolPolicies: { Bash: "deny" },
            },
          ],
        },
      });
      const ptplAfter = await db
        .selectFrom("platform_agent_template_versions")
        .select("definition")
        .where("template_id", "=", ptpl.id)
        .executeTakeFirstOrThrow();
      // no org connectors: `docs` stays as it is (inert), `todo` is an extension of the deployment
      expect(ptplAfter.definition).toMatchObject({
        tools: ["Read", "docs__search"],
        subagents: {
          inline: [
            {
              name: "helper",
              tools: ["Glob", "plugin__todo__write"],
              toolPolicies: { AskUserQuestion: "deny", plugin__todo__write: "ask" },
            },
          ],
        },
      });
      // idempotent: a second run leaves the rows as they are
      await db
        .insertInto("audit_events")
        .values([
          { org_id: orgA, action: "app.created", target: "c-1", detail: "{}" },
          { org_id: orgA, action: "app.credential.cleared", target: "c-1", detail: "{}" },
          { org_id: orgA, action: "app.installed", target: "x", detail: "{}" },
        ] as never)
        .execute();
      expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
      // connector actions written before the D17 rename take their current names; an `app.` action
      // that was never a connector's stays
      const actions = await db
        .selectFrom("audit_events")
        .select("action")
        .where("org_id", "=", orgA)
        .where("target", "in", ["c-1", "x"])
        .orderBy("id")
        .execute();
      expect(actions.map((r) => r.action)).toEqual([
        "connector.created",
        "connector.credential.cleared",
        "app.installed",
      ]);
      expect(
        (
          await db
            .selectFrom("agent_versions")
            .select("definition")
            .where("agent_id", "=", agentId)
            .executeTakeFirstOrThrow()
        ).definition,
      ).toEqual(after.definition);

      const got = await req({ method: "GET", url: `/api/v1/orgs/${orgA}/agents/${agentId}` });
      expect(got.statusCode, got.body).toBe(200);
      // runs: the rewritten `ask` policy applies to the connector tool (its default is allow)
      const conv = await createConv(req, orgA, agentId);
      await postMessage(req, orgA, conv, 'tool:mcp__docs__search:{"q":"x"}');
      const asked = await waitFor(
        async () => (await eventsOf(db, conv)).find((e) => e.type === "approval_requested") ?? null,
        20_000,
        "approval_requested",
      );
      expect(asked.payload).toMatchObject({ toolKey: "mcp__docs__search" });
    });

    it("saving a definition with an rc key is 400 validation_failed", async () => {
      const save = (definition: Record<string, unknown>) =>
        req({
          method: "POST",
          url: `/api/v1/orgs/${orgA}/agents`,
          payload: {
            definition: {
              name: "Old",
              instructions: "",
              model: { provider: "model-fake", model: "fake-1" },
              ...definition,
            },
            visibility: "org",
          },
        });
      const builtin = await save({ disabledTools: [{ kind: "builtin", name: "sandbox_bash" }] });
      expect(builtin.statusCode, builtin.body).toBe(400);
      expect(builtin.json()).toMatchObject({ error: { code: "validation_failed" } });

      const policy = await save({
        toolPolicies: { sandbox_read: "ask", docs__search: "deny" },
      });
      expect(policy.statusCode, policy.body).toBe(400);
      expect(policy.json()).toMatchObject({ error: { code: "validation_failed" } });

      const inline = await save({
        subagents: {
          inline: [{ name: "r", description: "d", instructions: "i", tools: ["sandbox_read"] }],
        },
      });
      expect(inline.statusCode, inline.body).toBe(400);
    });
  });
});
