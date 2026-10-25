import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  createDualReplicaHarness,
  type FakeMarketplace,
  type FakeMcpServer,
  type FakeNpmRegistry,
  type Harness,
  replicaOf,
  startFakeMarketplace,
  startFakeMcpServer,
  startFakeNpmRegistry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { casePlans } from "../../src/evals/plan.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { caseBase, type EvalResultView, type EvalRunView } from "../../src/evals/runs.service.js";
import { caseTitle } from "../../src/evals/sets.service.js";
import {
  type CaseSnapshot,
  readSnapshot,
  replayableCalls,
  toEvents,
} from "../../src/evals/snapshot.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MAINTENANCE_QUEUE_NAME, MARKETPLACES_REFRESH_JOB } from "../../src/runtime/maintenance.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { packOfficialPlugin } from "../helpers/plugin-packages.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { bundlePlugin, mcpTemplate, SVG_ICON, skillPlugin, templatePlugin } from "./packages.js";

/**
 * M6 segment 3 acceptance (dual replica, enterprise catalog): two kernel replicas in separate
 * processes (api / worker) share PG / Redis / the plugin directory, with
 * `extensionPermissions.autoApprove: false`; builtin object-store-s3 (SeaweedFS), config-declared
 * model-fake and connector-mcp; a fake npm registry, a fake official marketplace
 * (`marketplaces.official.url` points at it) plus one enterprise marketplace, and a fake MCP server.
 * Everything goes through HTTP ("the maintenance job refreshes the enterprise marketplace" enqueues
 * a real `catalogs-refresh` job on the maintenance queue; in the rename regression the "old agent
 * version" and the "snapshot case" have no HTTP write path and are written to the DB directly, as
 * in the T22 / T3 tests).
 *
 * 1. Import (every plugin through prepare -> confirm): on A, a templates-only plugin from npm and a
 *    skills-only plugin from a file; on B, refresh the official marketplace and import an entry
 *    (example-counter, extension only); after the maintenance job refreshes the enterprise
 *    marketplace, A sees the new entries; importing an entry with a tampered integrity -> 502
 *    `marketplace.integrity_mismatch`, nothing written;
 * 2. A plugin with every component: on A, import `todo` (its extension + an MCP connector template
 *    + a skill, depending on example-counter already in the catalog) from the enterprise
 *    marketplace, one review, its extension deployed, both replicas load todo without a restart; an
 *    org admin installs it on B: extension enabled, connector created with a tool snapshot, skill
 *    stored; the agent calls the connector tool and todo, and `skill_load` reads the skill;
 * 3. Uninstall: the connector is referenced by an agent -> `kept` lists it (used_by_agents), todo
 *    and the skill are removed, the agent still runs (dependency components arrive with Task 5);
 * 4. Policy and requests: the template item is needs_approval, a member request -> org admin
 *    approval (moved up) -> install possible only after enterprise admin approval; a member requests
 *    a skill, installed after approval; with `customConnectors: deny` a custom connector gets 403;
 * 5. Private agent with `writePolicy: "ask"`: `skill_write` creates an approval that takes effect
 *    once approved;
 * 6. Rename regression: T22's `pre-rename` fixture replays a single step with drift []; a
 *    single-step eval with it as the case shows no drift; an old agent version saved with
 *    `{kind:"app"}` runs on both replicas;
 * 7. Org upgrade across replicas (phase A1, spec §10): a declarative plugin (a skill and a connector
 *    template) installed at 1.0.0 on B is upgraded to 2.0.0 through A; B then shows the install at
 *    2.0.0 with nothing newer, the skill's new version (`skill_load` in a run on B reads it), the
 *    connector's new template default and its kept credential.
 *
 * "Without a restart": the replica ids (regenerated at each kernel start) and child process pids
 * stay the same from start to end.
 */

const S3_PLUGIN = fileURLToPath(
  new URL("../../../../plugins/object-store-s3/src/index.ts", import.meta.url),
);
const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);
const MCP_TOKEN = "tok-seg3";
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

type Fixture = { model: ModelInfo; snapshot: CaseSnapshot; requests: ModelRequest[] };
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../evals/fixtures/pre-rename/mcp-conversation.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

type Json = Record<string, unknown>;
type User = "root" | "boss" | "mem";
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>["payload"];
interface PluginView {
  name: string;
  status: string;
  version: string;
  sha256: string | null;
  reviewHash: string;
  replicas: { replicaId: string; state: string; version: string }[];
}

/**
 * Packs the official todo plugin with a connector template `docs` (and its icon), a skill
 * `crm-notes` and a dependency on example-counter added to the copy (the plugin with every
 * component).
 */
const packCrmTodo = () =>
  packOfficialPlugin("todo", async (dir) => {
    await mkdir(join(dir, "connectors"), { recursive: true });
    await mkdir(join(dir, "icons"), { recursive: true });
    await mkdir(join(dir, "skills", "crm-notes", "scripts"), { recursive: true });
    await writeFile(join(dir, "icons", "docs.svg"), SVG_ICON);
    await writeFile(
      join(dir, "connectors", "docs.json"),
      JSON.stringify({
        displayName: { zh: "文档", en: "Docs" },
        icon: "./icons/docs.svg",
        template: mcpTemplate(),
      }),
    );
    await writeFile(
      join(dir, "skills", "crm-notes", "SKILL.md"),
      SKILL_MD("crm-notes", "Take CRM notes."),
    );
    await writeFile(join(dir, "skills", "crm-notes", "scripts", "run.py"), "print(1)\n");
    const manifestPath = join(dir, ".capybara-plugin", "plugin.json");
    const m = JSON.parse(await readFile(manifestPath, "utf8"));
    m.dependencies = [{ name: "example-counter", version: "^0.1.0" }];
    m.icon = "./icons/docs.svg";
    await writeFile(manifestPath, JSON.stringify(m));
  });

/** A marketplace.json npm entry. */
const npmEntry = (
  name: string,
  pkg: string,
  version: string,
  tgz: Uint8Array,
  summary: string,
) => ({
  name,
  summary: { en: summary },
  minKernel: "0.0.1",
  source: { npm: { package: pkg, version, integrity: sri(tgz) } },
});

describe("M6 第三段双副本验收（企业目录）", { timeout: 240_000 }, () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let s3: TestS3;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let mcp: FakeMcpServer;
  let reg: FakeNpmRegistry;
  let official: FakeMarketplace;
  let acme: FakeMarketplace;
  let pluginsDir: string;
  let counterTgz: Uint8Array;
  let crmTgz: Uint8Array;
  let tamperedTgz: Uint8Array;
  const ids = {} as Record<User, string>;
  const jars: Record<User, Map<string, string>> = {
    root: new Map(),
    boss: new Map(),
    mem: new Map(),
  };
  const bootIds = new Map<0 | 1, string>();
  const bootPids: number[] = [];

  async function at(u: User, i: 0 | 1, method: string, path: string, body?: unknown) {
    const jar = jars[u];
    const binary = body instanceof Uint8Array;
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && {
          "content-type": binary ? "application/octet-stream" : "application/json",
        }),
      },
      ...(body !== undefined && { body: binary ? Buffer.from(body) : JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text === "" ? {} : (JSON.parse(text) as Json);
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  }
  const ok = async (u: User, i: 0 | 1, method: string, path: string, body?: unknown) => {
    const r = await at(u, i, method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json;
  };
  const errCode = (r: { json: Json }) => (r.json.error as { code?: string } | undefined)?.code;
  const view = async (name: string, i: 0 | 1 = 0) =>
    (await ok("root", i, "GET", `/api/v1/admin/extensions/${name}`)) as unknown as PluginView;
  const approve = async (i: 0 | 1, name: string) => {
    const v = await view(name, i);
    await ok("root", i, "POST", `/api/v1/admin/extensions/${name}/approve`, {
      sha256: v.sha256,
      reviewHash: v.reviewHash,
    });
  };
  const replicaIndex = (replicaId: string): 0 | 1 | undefined => {
    const pid = Number(/-(\d+)-[0-9a-f]{6}$/.exec(replicaId)?.[1]);
    return pid === h.replicas[0].pid ? 0 : pid === h.replicas[1].pid ? 1 : undefined;
  };
  /** 两个副本（都是启动时的副本 id）都已加载，部署状态 enabled。 */
  const loadedOnBoth = async (name: string, version?: string) => {
    const v = await view(name);
    if (v.status !== "enabled") return undefined;
    const loaded = new Set(
      v.replicas
        .filter((r) => r.state === "loaded" && (version === undefined || r.version === version))
        .map((r) => r.replicaId),
    );
    return loaded.has(bootIds.get(0) ?? "") && loaded.has(bootIds.get(1) ?? "") ? v : undefined;
  };

  beforeAll(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), "cap-m6s3-plugins-"));
    [pgc, rdc, s3, crmTgz, counterTgz] = await Promise.all([
      startTestPostgres(),
      startTestRedis(),
      startTestS3(),
      packCrmTodo(),
      packOfficialPlugin("example-counter"),
    ]);
    tamperedTgz = await skillPlugin("tampered", { packageName: "@acme/plugin-tampered" });
    mcp = await startFakeMcpServer({
      requireBearer: MCP_TOKEN,
      tools: [
        {
          name: "search",
          description: "Search the docs",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: true },
          handler: ({ args }) => ({ content: [{ type: "text", text: `hits for ${args.q}` }] }),
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
    reg = await startFakeNpmRegistry({
      packages: [
        { name: "@capybara-hq/plugin-todo", version: "0.1.0", tgz: crmTgz },
        { name: "@capybara-hq/plugin-example-counter", version: "0.1.0", tgz: counterTgz },
        {
          name: "@acme/github-mcp",
          version: "1.0.0",
          tgz: await templatePlugin("github-mcp", mcpTemplate(), {
            packageName: "@acme/github-mcp",
          }),
        },
        { name: "@acme/plugin-tampered", version: "1.0.0", tgz: tamperedTgz },
      ],
    });
    official = await startFakeMarketplace({
      manifest: {
        schemaVersion: 1,
        name: "Official",
        plugins: [
          npmEntry(
            "example-counter",
            "@capybara-hq/plugin-example-counter",
            "0.1.0",
            counterTgz,
            "Reference counter plugin",
          ),
        ],
      },
    });
    acme = await startFakeMarketplace({ manifest: acmeManifest(false) });
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, CONNECTOR_MCP],
      builtinExtensions: [S3_PLUGIN],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
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
      config: {
        auth: { cookieSecure: false },
        extensionPermissions: { autoApprove: false },
        extensionHost: { dir: pluginsDir, reconcileIntervalSeconds: 2 },
        packages: { npmRegistry: reg.url },
        marketplaces: {
          official: { enabled: true, url: official.url },
          allowInsecureLoopback: true,
        },
        tools: { timeoutMs: 10_000 },
      },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    const accounts = new AccountsService(db);
    ids.root = (
      await accounts.createLocal({
        login: "root",
        password: PW,
        displayName: "Root",
        enterpriseAdmin: true,
      })
    ).id;
    ids.boss = (
      await accounts.createLocal({ login: "boss", password: PW, displayName: "Boss" })
    ).id;
    ids.mem = (await accounts.createLocal({ login: "mem", password: PW, displayName: "Mem" })).id;
    for (const [u, i] of [
      ["root", 0],
      ["boss", 1],
      ["mem", 0],
    ] as const) {
      const r = await at(u, i, "POST", "/api/v1/auth/login", { login: u, password: PW });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    await waitFor(
      async () => {
        const rows = await db
          .selectFrom("extension_replica_status")
          .select("replica_id")
          .where("plugin", "=", "object-store-s3")
          .execute();
        for (const row of rows) {
          const i = replicaIndex(row.replica_id);
          if (i !== undefined) bootIds.set(i, row.replica_id);
        }
        return bootIds.size === 2;
      },
      20_000,
      "both replicas reported",
      100,
    );
    bootPids.push(h.replicas[0].pid, h.replicas[1].pid);
  }, 600_000);

  afterAll(async () => {
    // 先关测试自己的连接池：harness 停机时强制删库，池里的空闲连接会被管理员命令断开
    await raw?.destroy();
    await h?.stop();
    await Promise.all([mcp?.stop(), reg?.stop(), official?.stop(), acme?.stop()]);
    await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop()]);
    if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
  }, 120_000);

  /**
   * The enterprise marketplace: the todo plugin with every component; with `withTampered` also a
   * skill entry whose integrity is another package's.
   */
  function acmeManifest(withTampered: boolean) {
    return {
      schemaVersion: 1,
      name: "Acme",
      plugins: [
        npmEntry("todo", "@capybara-hq/plugin-todo", "0.1.0", crmTgz, "Todo with CRM notes"),
        ...(withTampered
          ? [{ ...npmEntry("tampered", "@acme/plugin-tampered", "1.0.0", crmTgz, "Tampered") }]
          : []),
      ],
    };
  }

  /** Confirms a staged import (prepare response) on replica `i`; returns the confirm body. */
  const confirmImport = (i: 0 | 1, staged: Json, deployExtension = false) =>
    ok("root", i, "POST", `/api/v1/admin/catalog/imports/${staged.stagingId as string}/confirm`, {
      reviewHash: (staged.review as { reviewHash: string }).reviewHash,
      deployExtension,
    });

  let orgId = "";
  let base = "";
  let templateItem = "";
  let skillItem = "";
  let acmeId = "";
  let appItem = "";
  let pluginInstallId = "";
  let counterInstallId = "";
  let connectorId = "";
  let appSkillId = "";
  let agentId = "";

  const newConv = async (u: User, i: 0 | 1, agent: string) =>
    (
      (await ok(u, i, "POST", `${base}/conversations`, { agentId: agent })).conversation as {
        id: string;
      }
    ).id;
  const send = async (u: User, i: 0 | 1, convId: string, key: string, input: unknown) => {
    const r = await at(u, i, "POST", `${base}/conversations/${convId}/messages`, {
      text: `tool:${key}:${JSON.stringify(input)}`,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
  };
  /** 第 n 个终态（须为 run_finished completed）那次运行的最后一条 tool_result。 */
  const finished = async (convId: string, n: number): Promise<ToolResult> => {
    const term = await waitForTerminal(db, convId, n, 60_000);
    const last = term[n - 1] as ConversationEvent;
    expect(last.type, JSON.stringify(last.payload)).toBe("run_finished");
    expect(last.payload).toMatchObject({ reason: "completed" });
    const evs = (await eventsOf(db, convId)).filter((e) => e.runId === last.runId);
    const result = evs.filter((e) => e.type === "tool_result").at(-1)?.payload;
    expect(result).toBeDefined();
    return result as ToolResult;
  };
  const call = async (
    u: User,
    i: 0 | 1,
    convId: string,
    key: string,
    input: unknown,
    n: number,
  ) => {
    await send(u, i, convId, key, input);
    const r = await finished(convId, n);
    expect(r.toolKey).toBe(key);
    return r;
  };
  const itemCount = async () =>
    (await db.selectFrom("catalog_items").select("id").execute()).length;

  it("1. 导入：npm 模板、文件技能、官方清单插件、维护任务刷新企业清单；integrity 篡改被拒且什么都没写", async () => {
    // 配置声明的插件待批准（autoApprove 关闭），先批准
    await approve(0, "model-fake");
    await approve(1, "connector-mcp");
    await waitFor(() => loadedOnBoth("model-fake"), 30_000, "model-fake on both", 100);
    await waitFor(() => loadedOnBoth("connector-mcp"), 30_000, "connector-mcp on both", 100);

    // A: a templates-only plugin from npm
    const tpl = await confirmImport(
      0,
      await ok("root", 0, "POST", "/api/v1/admin/catalog/import/npm", {
        package: "@acme/github-mcp",
      }),
    );
    templateItem = (tpl.item as { id: string }).id;
    expect(tpl.item).toMatchObject({ name: "github-mcp" });
    expect(reg.requests.some((p) => p.includes("github-mcp"))).toBe(true);
    // A: a skills-only plugin from a file
    const sk = await confirmImport(
      0,
      await ok(
        "root",
        0,
        "POST",
        "/api/v1/admin/catalog/import/file",
        await skillPlugin("sql-helper"),
      ),
    );
    skillItem = (sk.item as { id: string }).id;
    expect(sk.item).toMatchObject({ name: "sql-helper" });

    // B: refresh the official marketplace and import an entry
    const off = await ok("root", 1, "POST", "/api/v1/admin/marketplaces/official/refresh");
    expect(off.lastStatus).toBe("ok");
    const imported = await at(
      "root",
      1,
      "POST",
      "/api/v1/admin/marketplaces/official/entries/example-counter/import",
      { version: "0.1.0" },
    );
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    const counterItem = ((await confirmImport(1, imported.json)).item as { id: string }).id;
    // Installed on the deployment (the import's review approved its permissions), then enabled:
    // the todo plugin depends on it
    await ok("root", 1, "POST", `/api/v1/admin/catalog/items/${counterItem}/install-deployment`, {
      version: "0.1.0",
    });
    expect((await view("example-counter", 1)).status).toBe("disabled");
    await ok("root", 1, "POST", "/api/v1/admin/extensions/example-counter/enable");
    await waitFor(() => loadedOnBoth("example-counter", "0.1.0"), 30_000, "counter on both", 100);

    // 企业清单：加上后没刷新过、没有条目；维护任务刷新后 A 上能看到；清单再加条目，维护任务再刷新，A 上看到新条目
    const added = await ok("root", 1, "POST", "/api/v1/admin/marketplaces", {
      name: "Acme",
      url: acme.url,
    });
    acmeId = added.id as string;
    const entriesOnA = async () =>
      (
        (await ok("root", 0, "GET", `/api/v1/admin/marketplaces/entries?sourceId=${acmeId}`))
          .items as {
          name: string;
        }[]
      ).map((e) => e.name);
    expect(await entriesOnA()).toEqual([]);
    const conn = new Redis(rdc.url, { maxRetriesPerRequest: null });
    const maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: conn });
    try {
      const before = acme.requests.length;
      await maint.add(MARKETPLACES_REFRESH_JOB, {});
      await waitFor(
        async () => (await entriesOnA()).includes("todo"),
        30_000,
        "maintenance refreshed the enterprise catalog",
        200,
      );
      expect(acme.requests.length).toBeGreaterThan(before);
      acme.setManifest(acmeManifest(true));
      await maint.add(MARKETPLACES_REFRESH_JOB, {});
      await waitFor(
        async () => (await entriesOnA()).includes("tampered"),
        30_000,
        "new entry visible on A",
        200,
      );
    } finally {
      await maint.close();
      conn.disconnect();
    }

    // Tampered integrity: 502 marketplace.integrity_mismatch, nothing written
    const itemsBefore = await itemCount();
    const auditBefore = await db.selectFrom("audit_events").select("id").execute();
    const bad = await at(
      "root",
      0,
      "POST",
      `/api/v1/admin/marketplaces/${acmeId}/entries/tampered/import`,
      { version: "1.0.0" },
    );
    expect(bad.status, JSON.stringify(bad.json)).toBe(502);
    expect(errCode(bad)).toBe("marketplace.integrity_mismatch");
    expect(await itemCount()).toBe(itemsBefore);
    expect(
      await db.selectFrom("catalog_items").select("id").where("name", "=", "tampered").execute(),
    ).toEqual([]);
    expect((await db.selectFrom("audit_events").select("id").execute()).length).toBe(
      auditBefore.length,
    );

    // 组织：root 是所有者，boss 组织管理员，mem 成员；example-counter 在本组织启用（之后应用会引用它）
    const org = await ok("root", 0, "POST", "/api/v1/orgs", { name: "Acme" });
    orgId = (org.org as { id: string }).id;
    base = `/api/v1/orgs/${orgId}`;
    await testMembers(db).add(orgId, ids.boss, "admin", ids.root);
    await testMembers(db).add(orgId, ids.mem, "member", ids.root);
    await ok("boss", 1, "PUT", `${base}/extensions/example-counter`, { enabled: true });
  });

  it("2. 应用包：引入、一次审阅装到部署（两边不重启加载），B 上组织安装，agent 用到连接器、todo 与技能", async () => {
    const staged = await at(
      "root",
      0,
      "POST",
      `/api/v1/admin/marketplaces/${acmeId}/entries/todo/import`,
      {},
    );
    expect(staged.status, JSON.stringify(staged.json)).toBe(200);
    const review = staged.json.review as {
      reviewHash: string;
      extension: { name: string; action: string };
      connectorTemplates: { id: string }[];
      skills: { name: string }[];
      dependencies: { name: string; resolved: string | null }[];
    };
    expect(review.extension).toMatchObject({ name: "todo", action: "install" });
    expect(review.connectorTemplates.map((t) => t.id)).toEqual(["docs"]);
    expect(review.skills.map((s) => s.name)).toEqual(["crm-notes"]);
    expect(review.dependencies).toEqual([
      { name: "example-counter", range: "^0.1.0", resolved: "0.1.0" },
    ]);
    const confirmed = await confirmImport(0, staged.json, true);
    appItem = (confirmed.item as { id: string }).id;
    expect(confirmed.deploy).toMatchObject({ name: "todo", action: "install", result: "enabled" });
    // 审阅即批准：todo 不再单独待批准，两个副本都加载
    await waitFor(() => loadedOnBoth("todo", "0.1.0"), 30_000, "todo on both", 100);

    // 组织管理员在 B 上安装应用
    const inst = await at("boss", 1, "POST", `${base}/catalog/${appItem}/install`, {
      connectors: { docs: { endpoint: { url: mcp.url }, credential: { token: MCP_TOKEN } } },
    });
    expect(inst.status, JSON.stringify(inst.json)).toBe(201);
    pluginInstallId = (inst.json.installed as { pluginInstallId: string }).pluginInstallId;
    // The dependency example-counter got its own install, recorded as a component of the plugin's
    // (its extension was already enabled in the org: created=false there)
    const installs = (await ok("boss", 0, "GET", `${base}/plugin-installs`)).installs as {
      id: string;
      name: string;
      components: { kind: string; ref: string; created: boolean }[];
    }[];
    const counter = installs.find((i) => i.name === "example-counter");
    expect(counter?.components).toEqual([
      {
        kind: "extension",
        ref: "example-counter",
        created: false,
        skillVersion: null,
        dropped: false,
      },
    ]);
    counterInstallId = counter?.id as string;
    expect(installs.find((i) => i.id === pluginInstallId)?.components).toContainEqual({
      kind: "plugin",
      ref: counterInstallId,
      created: true,
      skillVersion: null,
      dropped: false,
    });
    const enabled = await db
      .selectFrom("extension_org_configs")
      .select("plugin")
      .where("org_id", "=", orgId)
      .where("enabled", "=", true)
      .orderBy("plugin")
      .execute();
    expect(enabled.map((r) => r.plugin)).toEqual(["example-counter", "todo"]);
    const conn = await db
      .selectFrom("connectors")
      .select(["id", "slug", "catalog_item_id"])
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(conn).toMatchObject({ slug: "docs", catalog_item_id: appItem });
    connectorId = conn.id;
    const tools = await db
      .selectFrom("connector_tools")
      .select(["name", "default_policy", "policy_source"])
      .where("connector_id", "=", connectorId)
      .orderBy("name")
      .execute();
    expect(tools).toEqual([
      { name: "delete_all", default_policy: "ask", policy_source: "derived" },
      { name: "search", default_policy: "allow", policy_source: "template" },
    ]);
    const skills = (await ok("boss", 0, "GET", `${base}/skills`)).skills as {
      id: string;
      name: string;
    }[];
    const crm = skills.find((s) => s.name === "crm-notes");
    expect(crm).toBeDefined();
    appSkillId = (crm as { id: string }).id;

    // agent：连接器工具、todo、skill_load（引用应用带来的技能）
    const ag = await ok("boss", 0, "POST", `${base}/agents`, {
      definition: {
        name: "Sales",
        instructions: "Use the tools.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "connector", connectorId, tools: "all" },
          { kind: "plugin", plugin: "todo", name: "write" },
          { kind: "builtin", name: "skill_load" },
        ],
        skills: { orgSkills: [appSkillId] },
      },
      visibility: "org",
    });
    agentId = (ag.agent as { id: string }).id;
    const conv = await newConv("boss", 1, agentId);
    const r1 = await call("boss", 0, conv, "docs__search", { q: "deals" }, 1);
    expect(r1.isError, String(r1.content)).toBe(false);
    expect(String(r1.content)).toContain("hits for deals");
    const r2 = await call(
      "boss",
      1,
      conv,
      "todo__write",
      { todos: [{ content: "Call", status: "pending", activeForm: "Calling" }] },
      2,
    );
    expect(r2.isError, String(r2.content)).toBe(false);
    expect(String(r2.content)).toContain("Todo list updated (1 items)");
    const r3 = await call("boss", 0, conv, "skill_load", { name: "crm-notes" }, 3);
    expect(r3.isError, String(r3.content)).toBe(false);
    expect(String(r3.content)).toContain("# crm-notes");
  });

  it("3. 卸载：kept 列出之前已启用的插件与被 agent 引用的连接器，其余移除，agent 仍能运行", async () => {
    // agent 不再引用技能（只留连接器与 todo），技能应被移除
    const cur = await ok("boss", 1, "GET", `${base}/agents/${agentId}`);
    const def = (cur.agent as { definition: Record<string, unknown> }).definition;
    await ok("boss", 1, "PATCH", `${base}/agents/${agentId}`, {
      definition: { ...def, skills: { orgSkills: [] } },
    });
    const rep = await ok("boss", 0, "DELETE", `${base}/plugin-installs/${pluginInstallId}`);
    const byKey = (xs: { kind: string; ref: string }[]) =>
      [...xs].sort((a, b) => `${a.kind}${a.ref}`.localeCompare(`${b.kind}${b.ref}`));
    expect(byKey(rep.kept as { kind: string; ref: string }[])).toEqual([
      { kind: "connector", ref: connectorId, reason: "used_by_agents" },
      { kind: "extension", ref: "example-counter", reason: "pre_existing" },
    ]);
    expect(byKey(rep.removed as { kind: string; ref: string }[])).toEqual([
      { kind: "extension", ref: "todo" },
      { kind: "plugin", ref: counterInstallId },
      { kind: "skill", ref: appSkillId },
    ]);
    const enabled = await db
      .selectFrom("extension_org_configs")
      .select("plugin")
      .where("org_id", "=", orgId)
      .where("enabled", "=", true)
      .execute();
    expect(enabled.map((r) => r.plugin)).toEqual(["example-counter"]);
    const liveSkill = await db
      .selectFrom("skills")
      .select("id")
      .where("id", "=", appSkillId)
      .where("deleted_at", "is", null)
      .execute();
    expect(liveSkill).toEqual([]);
    expect((await ok("boss", 1, "GET", `${base}/plugin-installs`)).installs).toEqual([]);
    // agent 仍能运行：连接器工具照常可用
    const conv = await newConv("boss", 1, agentId);
    const r = await call("boss", 0, conv, "docs__search", { q: "after" }, 1);
    expect(r.isError, String(r.content)).toBe(false);
    expect(String(r.content)).toContain("hits for after");
    // agent 定义里仍留着对 todo 的引用（插件已在本组织停用）：运行照常结束，调它只得到工具错误
    const left = await ok("boss", 0, "GET", `${base}/agents/${agentId}`);
    expect(
      (left.agent as { definition: { tools: { kind: string; plugin?: string }[] } }).definition
        .tools,
    ).toContainEqual(expect.objectContaining({ kind: "plugin", plugin: "todo" }));
    const dangling = await call(
      "boss",
      1,
      conv,
      "todo__write",
      { todos: [{ content: "Call", status: "pending", activeForm: "Calling" }] },
      2,
    );
    expect(dangling.isError).toBe(true);
  });

  it("4. 策略与申请：模板两级审批后才能安装；成员申请技能批准后入库；customConnectors deny 时自建 403", async () => {
    await ok("root", 0, "PUT", `/api/v1/admin/catalog/items/${templateItem}/policy`, {
      policy: "needs_approval",
    });
    const connectorBody = {
      connectors: {
        "github-mcp": {
          name: "GitHub",
          endpoint: { url: mcp.url },
          credential: { token: MCP_TOKEN },
        },
      },
    };
    // 成员申请 → 组织管理员批准：条目需审批且本组织没有授予 → 升级到企业管理员
    const asked = await ok("mem", 0, "POST", `${base}/catalog/${templateItem}/requests`, {
      note: "Need GitHub",
    });
    const reqId = (asked.request as { id: string }).id;
    expect(asked.request).toMatchObject({ stage: "org", status: "pending" });
    const orgDecided = await ok("boss", 1, "POST", `${base}/catalog-requests/${reqId}/decide`, {
      decision: "approve",
    });
    expect(orgDecided.request).toMatchObject({ stage: "deployment", status: "pending" });
    // 企业管理员批准之前不能安装：202，什么都没建
    const pending = await at("boss", 0, "POST", `${base}/catalog/${templateItem}/install`, {
      ...connectorBody,
    });
    expect(pending.status, JSON.stringify(pending.json)).toBe(202);
    expect(pending.json.request).toMatchObject({ id: reqId, stage: "deployment" });
    const liveConnectors = () =>
      db
        .selectFrom("connectors")
        .select("id")
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .execute();
    expect(await liveConnectors()).toHaveLength(1);
    const inboxAdmin = (await ok("root", 1, "GET", "/api/v1/admin/catalog/requests")).requests as {
      id: string;
    }[];
    expect(inboxAdmin.map((r) => r.id)).toEqual([reqId]);
    const decided = await ok("root", 1, "POST", `/api/v1/admin/catalog/requests/${reqId}/decide`, {
      decision: "approve",
    });
    expect(decided.request).toMatchObject({ status: "approved" });
    const installed = await at("boss", 0, "POST", `${base}/catalog/${templateItem}/install`, {
      ...connectorBody,
    });
    expect(installed.status, JSON.stringify(installed.json)).toBe(201);
    expect(await liveConnectors()).toHaveLength(2);

    // 成员申请技能 → 组织管理员批准 → 安装入库
    const sk = await ok("mem", 1, "POST", `${base}/catalog/${skillItem}/requests`, {});
    const skReq = (sk.request as { id: string }).id;
    const skDecided = await ok("boss", 0, "POST", `${base}/catalog-requests/${skReq}/decide`, {
      decision: "approve",
    });
    expect(skDecided.request).toMatchObject({ stage: "org", status: "approved" });
    const skInst = await at("boss", 1, "POST", `${base}/catalog/${skillItem}/install`, {});
    expect(skInst.status, JSON.stringify(skInst.json)).toBe(201);
    const lib = (await ok("mem", 0, "GET", `${base}/skills`)).skills as { name: string }[];
    expect(lib.map((s) => s.name)).toContain("sql-helper");

    // customConnectors deny：自建连接器 403（两个副本都一样）；断言失败也要恢复，免得影响后面的用例
    await ok("root", 1, "PUT", "/api/v1/admin/settings", { customConnectors: "deny" });
    try {
      for (const i of [0, 1] as const) {
        const custom = await at("boss", i, "POST", `${base}/connectors`, {
          name: "Mine",
          connector: "mcp",
          endpoint: { url: mcp.url },
          auth: { type: "bearer", ownership: "org" },
          credential: { token: MCP_TOKEN },
        });
        expect(custom.status, JSON.stringify(custom.json)).toBe(403);
        expect(errCode(custom)).toBe("catalog.custom_disabled");
      }
    } finally {
      await ok("root", 0, "PUT", "/api/v1/admin/settings", { customConnectors: "allow" });
    }
  });

  it("5. 私有 agent writePolicy ask：skill_write 产生审批，批准后直接生效", async () => {
    const ag = await ok("boss", 0, "POST", `${base}/agents`, {
      definition: {
        name: "Mine",
        instructions: "Write skills.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "skill_write" }],
        skills: { writePolicy: "ask" },
      },
      visibility: "private",
    });
    const privateId = (ag.agent as { id: string }).id;
    const conv = await newConv("boss", 1, privateId);
    await send("boss", 0, conv, "skill_write", {
      name: "asked",
      description: "Use when asked.",
      files: [{ path: "SKILL.md", content: "# Asked v1" }],
    });
    const a = await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select(["id", "tool_key"])
          .where("conversation_id", "=", conv)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "skill_write approval",
    );
    expect(a.tool_key).toBe("skill_write");
    expect(
      await db.selectFrom("skills").select("id").where("agent_id", "=", privateId).execute(),
    ).toEqual([]);
    await ok("boss", 1, "POST", `${base}/approvals/${a.id}/decision`, { decision: "approve" });
    const r = await finished(conv, 1);
    expect(r.isError, String(r.content)).toBe(false);
    const skill = await db
      .selectFrom("skills")
      .select(["name", "current_version"])
      .where("agent_id", "=", privateId)
      .executeTakeFirstOrThrow();
    expect(skill).toEqual({ name: "asked", current_version: 1 });
    expect(await db.selectFrom("skill_change_requests").select("id").execute()).toEqual([]);
  });

  it("6. 改名回归：pre-rename 夹具单步还原无 drift、单步评测无 drift 标记、旧形 agent 版本两边都能运行", async () => {
    // 当前代码上的单步还原
    const calls = toEvents(fixture.snapshot).filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const [i, c] of calls.entries()) {
      const out = reconstructRequest(fixture.snapshot, c.seq, { model: fixture.model });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(fixture.requests[i]);
    }

    // 以夹具为用例的单步评测运行（用例写入没有「从快照导入」的 HTTP 入口：按 sets.service 的同样算法直接写库）
    const set = await ok("boss", 0, "POST", `${base}/eval-sets`, {
      agentId,
      name: "Rename regression",
    });
    const setId = (set.set as { id: string }).id;
    const snapshot = readSnapshot(structuredClone(fixture.snapshot));
    const json = JSON.stringify(fixture.snapshot);
    const plans = casePlans(snapshot);
    const cb = await caseBase(db, snapshot);
    await db
      .insertInto("eval_cases")
      .values({
        set_id: setId,
        org_id: orgId,
        source_conversation_id: snapshot.conversationId,
        source_run_id: snapshot.runId,
        agent_version: snapshot.agentVersion,
        title: caseTitle(snapshot),
        snapshot: json,
        snapshot_bytes: Buffer.byteLength(json),
        replayable_steps: replayableCalls(snapshot).length,
        plan_step: JSON.stringify(plans.step),
        plan_run: JSON.stringify(plans.run),
        base_model: cb ? JSON.stringify(cb.definition.model) : null,
        added_by: ids.boss,
      })
      .execute();
    const started = await ok("boss", 1, "POST", `${base}/eval-sets/${setId}/runs`, {
      mode: "step",
      candidate: { model: { provider: "model-fake", model: "fake-1" } },
    });
    const runId = (started.run as EvalRunView).id;
    const done = await waitFor(
      async () => {
        const v = (await ok("boss", 0, "GET", `${base}/eval-runs/${runId}`)).run as EvalRunView;
        return v.status === "queued" || v.status === "running" ? null : v;
      },
      60_000,
      "step eval run finished",
      200,
    );
    expect(done).toMatchObject({ status: "completed", error: null, casesDone: 1 });
    const results = (
      (await ok("boss", 1, "GET", `${base}/eval-runs/${runId}/results?limit=200`)) as {
        results: EvalResultView[];
      }
    ).results;
    expect(results).toHaveLength(replayableCalls(snapshot).length);
    expect(results.map((r) => [r.status, r.drift])).toEqual(results.map(() => ["done", []]));
    expect(done.summary).toMatchObject({ drifted: 0 });

    // 以 {kind:"app"} 保存的旧 agent 版本：直接把旧形写回库（改名前存的版本），两个副本都能运行
    const ag = await ok("boss", 0, "POST", `${base}/agents`, {
      definition: {
        name: "Legacy",
        instructions: "Search the docs.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "connector", connectorId, tools: "all" }],
      },
      visibility: "org",
    });
    const legacyId = (ag.agent as { id: string }).id;
    const stored = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", legacyId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...(stored.definition as Record<string, unknown>),
          tools: [{ kind: "app", appId: connectorId, tools: "all" }],
        }),
      })
      .where("agent_id", "=", legacyId)
      .execute();
    for (const i of [0, 1] as const) {
      const conv = await newConv("boss", i, legacyId);
      const r = await call("boss", i, conv, "docs__search", { q: `replica ${i}` }, 1);
      expect(r.isError, String(r.content)).toBe(false);
      expect(String(r.content)).toContain(`hits for replica ${i}`);
    }

    // 从头到尾没有重启：子进程与副本 id 都没变
    expect([h.replicas[0].pid, h.replicas[1].pid]).toEqual(bootPids);
    const replicaIds = await db
      .selectFrom("extension_replica_status")
      .select("replica_id")
      .distinct()
      .execute();
    expect(replicaIds.map((r) => r.replica_id).sort()).toEqual([...bootIds.values()].sort());
  });

  it("7. upgrade across replicas: installed at 1.0.0 on B, upgraded to 2.0.0 through A; B sees the version, the new skill content, the new template default and the kept credential", async () => {
    const kitMd = (v: string) =>
      `---\nname: kit-notes\ndescription: Keep kit notes.\n---\n# kit-notes ${v}\n\nSteps ${v}.\n`;
    const kit = (version: string, search: "allow" | "ask") =>
      bundlePlugin({
        name: "kit",
        version,
        templates: { "kit-docs": mcpTemplate({ defaultToolPolicies: { search } }) },
        files: { "skills/kit-notes/SKILL.md": kitMd(version) },
      });
    // Both versions imported on A (the second adds a version to the same item)
    const v1 = await confirmImport(
      0,
      await ok("root", 0, "POST", "/api/v1/admin/catalog/import/file", await kit("1.0.0", "allow")),
    );
    const kitItem = (v1.item as { id: string }).id;
    // B: installed at 1.0.0, an agent selects the skill
    const inst = await at("boss", 1, "POST", `${base}/catalog/${kitItem}/install`, {
      version: "1.0.0",
      connectors: {
        "kit-docs": {
          name: "Kit Docs",
          endpoint: { url: mcp.url },
          credential: { token: MCP_TOKEN },
        },
      },
    });
    expect(inst.status, JSON.stringify(inst.json)).toBe(201);
    const installId = (inst.json.installed as { pluginInstallId: string }).pluginInstallId;
    const v2 = await confirmImport(
      0,
      await ok("root", 0, "POST", "/api/v1/admin/catalog/import/file", await kit("2.0.0", "ask")),
    );
    expect((v2.item as { id: string }).id).toBe(kitItem);
    type InstallView = {
      id: string;
      version: string;
      status: string;
      upgradeAvailable: string | null;
    };
    const installOn = async (i: 0 | 1) =>
      ((await ok("boss", i, "GET", `${base}/plugin-installs`)).installs as InstallView[]).find(
        (x) => x.id === installId,
      );
    expect(await installOn(1)).toMatchObject({ version: "1.0.0", upgradeAvailable: "2.0.0" });
    const skill = (
      (await ok("boss", 1, "GET", `${base}/skills`)).skills as {
        id: string;
        name: string;
        currentVersion: number;
      }[]
    ).find((x) => x.name === "kit-notes");
    expect(skill?.currentVersion).toBe(1);
    const kitConn = await db
      .selectFrom("plugin_install_components")
      .select("ref as id")
      .where("install_id", "=", installId)
      .where("kind", "=", "connector")
      .where("template_id", "=", "kit-docs")
      .executeTakeFirstOrThrow();
    const conn = async (i: 0 | 1) =>
      (await ok("boss", i, "GET", `${base}/connectors/${kitConn.id}`)).connector as {
        tools: { name: string; defaultPolicy: string }[];
        credential: { status: string };
      };
    expect((await conn(1)).tools.find((t) => t.name === "search")?.defaultPolicy).toBe("allow");
    const ag = await ok("boss", 1, "POST", `${base}/agents`, {
      definition: {
        name: "Kit",
        instructions: "Load the skill.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "builtin", name: "skill_load" }],
        skills: { orgSkills: [skill?.id] },
      },
      visibility: "org",
    });
    const kitAgent = (ag.agent as { id: string }).id;
    const before = await newConv("boss", 1, kitAgent);
    const r1 = await call("boss", 1, before, "skill_load", { name: "kit-notes" }, 1);
    expect(String(r1.content)).toContain("Steps 1.0.0.");

    // A: preview and upgrade
    const p = await ok("boss", 0, "POST", `${base}/plugin-installs/${installId}/upgrade/preview`, {
      version: "2.0.0",
    });
    expect(p).toMatchObject({ from: "1.0.0", to: "2.0.0" });
    expect(p.components).toEqual([
      { kind: "skill", ref: "kit-notes", change: "changed" },
      { kind: "connector", ref: "kit-docs", change: "changed" },
    ]);
    const up = await ok("boss", 0, "POST", `${base}/plugin-installs/${installId}/upgrade`, {
      version: "2.0.0",
      diffHash: p.diffHash,
    });
    expect(up.install).toMatchObject({ version: "2.0.0", status: "installed" });

    // B sees the upgrade: the install, the org catalog, the skill, the connector
    expect(await installOn(1)).toMatchObject({
      version: "2.0.0",
      status: "installed",
      upgradeAvailable: null,
    });
    const items = (await ok("boss", 1, "GET", `${base}/catalog`)).items as {
      id: string;
      installed: unknown;
    }[];
    expect(items.find((x) => x.id === kitItem)?.installed).toEqual({
      pluginInstallId: installId,
      version: "2.0.0",
      upgradeAvailable: null,
    });
    const skills = (await ok("boss", 1, "GET", `${base}/skills`)).skills as {
      id: string;
      name: string;
      currentVersion: number;
    }[];
    expect(skills.find((x) => x.name === "kit-notes")).toMatchObject({
      id: skill?.id,
      currentVersion: 2,
    });
    const after = await conn(1);
    expect(after.tools.find((t) => t.name === "search")?.defaultPolicy).toBe("ask");
    expect(after.credential.status).toBe("connected");
    // The agent is unchanged (same version, same selection); a run on B loads the new content
    const agentNow = await ok("boss", 1, "GET", `${base}/agents/${kitAgent}`);
    expect(agentNow.agent).toMatchObject({
      currentVersion: 1,
      definition: { skills: { orgSkills: [skill?.id] } },
    });
    const conv = await newConv("boss", 1, kitAgent);
    const r2 = await call("boss", 1, conv, "skill_load", { name: "kit-notes" }, 1);
    expect(r2.isError, String(r2.content)).toBe(false);
    expect(String(r2.content)).toContain("Steps 2.0.0.");
    expect([h.replicas[0].pid, h.replicas[1].pid]).toEqual(bootPids);
  });
});
