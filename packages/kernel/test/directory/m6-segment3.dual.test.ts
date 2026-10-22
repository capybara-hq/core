import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  createDualReplicaHarness,
  type FakeCatalog,
  type FakeMcpServer,
  type FakeNpmRegistry,
  type Harness,
  replicaOf,
  startFakeCatalog,
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
import { CATALOGS_REFRESH_JOB, MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { packOfficialPlugin } from "../helpers/plugin-packages.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";
import { SKILL_MD } from "../skills/zip.js";
import { appBundleTgz, mcpTemplate, SVG_ICON, skillTgz, templateTgz } from "./packages.js";

/**
 * M6 第三段验收（双副本，企业目录）：两个独立进程的内核副本（api / worker）共享 PG / Redis / 插件目录，
 * `pluginPermissions.autoApprove: false`；内置 object-store-s3（SeaweedFS）、配置声明的 model-fake 与 connector-mcp；
 * 假 npm registry、假官方清单（`catalogs.official.url` 指向它）与一个企业清单、假 MCP 服务器。全部经 HTTP
 * （「维护任务刷新企业清单」往维护队列投真实的 `catalogs-refresh` 任务；改名回归里「旧版本 agent」与「快照用例」
 * 没有 HTTP 写入口，直接写库，与 T22 / T3 的测试一致）。
 *
 * 1. 导入：A 上从 npm 导入连接器模板、从文件导入技能包；B 上刷新官方清单并引入插件条目（example-counter）；
 *    维护任务刷新企业清单后 A 上能看到新条目；integrity 被篡改的条目引入 → 502 `catalog.integrity_mismatch`，什么都没写；
 * 2. 应用包：A 上从企业清单引入应用（todo + MCP 连接器模板 + 技能，另引用已在部署上的 example-counter），一次审阅、
 *    装到部署，两个副本不重启地加载 todo；组织管理员在 B 上安装：插件启用、连接器建好且有工具快照、技能入库；
 *    agent 调连接器工具与 todo，`skill_load` 读到技能；
 * 3. 卸载：example-counter 在安装前就已启用、连接器被 agent 引用 → `kept` 列出这两项（pre_existing / used_by_agents），
 *    todo 与技能被移除，agent 仍能运行；
 * 4. 策略与申请：模板条目 needs_approval，成员申请 → 组织管理员批准（升级）→ 企业管理员批准后才能安装；成员申请技能，
 *    批准后安装入库；`customConnectors: deny` 时自建连接器 403；
 * 5. 私有 agent `writePolicy: "ask"`：`skill_write` 产生审批，批准后直接生效；
 * 6. 改名回归：T22 的 `pre-rename` 夹具单步还原 drift 为 []；以它为用例跑一次单步评测，结果没有 drift；
 *    以 `{kind:"app"}` 保存的旧 agent 版本在两个副本上都能运行。
 *
 * 「不重启」：副本 id（每次内核启动重新生成）与子进程 pid 从头到尾不变。
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

const APP_MANIFEST = (todo: Uint8Array, counter: Uint8Array) => ({
  schemaVersion: 1,
  name: "crm-suite",
  version: "1.0.0",
  publisher: "Acme",
  description: "CRM tools for sales teams",
  displayName: { zh: "CRM 套件", en: "CRM Suite" },
  plugins: [
    {
      name: "todo",
      npm: "@capybara-hq/plugin-todo",
      version: "^0.1.0",
      lock: { version: "0.1.0", integrity: sri(todo) },
    },
    {
      name: "example-counter",
      npm: "@capybara-hq/plugin-example-counter",
      version: "^0.1.0",
      lock: { version: "0.1.0", integrity: sri(counter) },
    },
  ],
  connectorTemplates: [
    {
      id: "docs",
      displayName: { zh: "文档", en: "Docs" },
      template: mcpTemplate({ icon: "icons/docs.svg" }),
    },
  ],
  skills: [{ path: "skills/crm-notes" }],
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
  let official: FakeCatalog;
  let acme: FakeCatalog;
  let pluginsDir: string;
  let todoTgz: Uint8Array;
  let counterTgz: Uint8Array;
  let appTgz: Uint8Array;
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
    (await ok("root", i, "GET", `/api/v1/admin/plugins/${name}`)) as unknown as PluginView;
  const approve = async (i: 0 | 1, name: string) => {
    const v = await view(name, i);
    await ok("root", i, "POST", `/api/v1/admin/plugins/${name}/approve`, {
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
    [pgc, rdc, s3, todoTgz, counterTgz] = await Promise.all([
      startTestPostgres(),
      startTestRedis(),
      startTestS3(),
      packOfficialPlugin("todo"),
      packOfficialPlugin("example-counter"),
    ]);
    appTgz = await appBundleTgz({
      name: "@acme/app-crm-suite",
      manifest: APP_MANIFEST(todoTgz, counterTgz),
      files: [
        { path: "icons/docs.svg", data: SVG_ICON },
        { path: "skills/crm-notes/SKILL.md", data: SKILL_MD("crm-notes", "Take CRM notes.") },
        { path: "skills/crm-notes/scripts/run.py", data: "print(1)\n" },
      ],
    });
    tamperedTgz = await skillTgz({ name: "@acme/skill-tampered", skillName: "tampered" });
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
        { name: "@capybara-hq/plugin-todo", version: "0.1.0", tgz: todoTgz },
        { name: "@capybara-hq/plugin-example-counter", version: "0.1.0", tgz: counterTgz },
        { name: "@acme/github-mcp", version: "1.0.0", tgz: await templateTgz() },
        { name: "@acme/app-crm-suite", version: "1.0.0", tgz: appTgz },
        { name: "@acme/skill-tampered", version: "1.0.0", tgz: tamperedTgz },
      ],
    });
    official = await startFakeCatalog({
      index: {
        schemaVersion: 1,
        name: "Official",
        updatedAt: "2026-10-22T00:00:00Z",
        entries: [
          {
            kind: "plugin",
            name: "example-counter",
            npm: "@capybara-hq/plugin-example-counter",
            publisher: "Capybara",
            summary: { en: "Reference counter plugin" },
            versions: [
              {
                version: "0.1.0",
                integrity: sri(counterTgz),
                minKernel: "0.0.1",
                minSdk: "0.1.0",
              },
            ],
          },
        ],
      },
    });
    acme = await startFakeCatalog({ index: acmeIndex(false) });
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, CONNECTOR_MCP],
      builtinPlugins: [S3_PLUGIN],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
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
      config: {
        auth: { cookieSecure: false },
        pluginPermissions: { autoApprove: false },
        pluginHost: { dir: pluginsDir, reconcileIntervalSeconds: 2 },
        packages: { npmRegistry: reg.url },
        catalogs: { official: { enabled: true, url: official.url }, allowInsecureLoopback: true },
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
          .selectFrom("plugin_replica_status")
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

  /** 企业清单：应用条目；`withTampered` 时另有一个 integrity 被篡改的技能条目（清单 sha512 是别的包的）。 */
  function acmeIndex(withTampered: boolean) {
    return {
      schemaVersion: 1,
      name: "Acme",
      updatedAt: "2026-10-22T00:00:00Z",
      entries: [
        {
          kind: "app",
          name: "crm-suite",
          npm: "@acme/app-crm-suite",
          publisher: "Acme",
          summary: { en: "CRM suite" },
          versions: [{ version: "1.0.0", integrity: sri(appTgz), minKernel: "0.0.1" }],
        },
        ...(withTampered
          ? [
              {
                kind: "skill",
                name: "tampered",
                npm: "@acme/skill-tampered",
                publisher: "Acme",
                summary: { en: "Tampered skill" },
                versions: [{ version: "1.0.0", integrity: sri(appTgz), minKernel: "0.0.1" }],
              },
            ]
          : []),
      ],
    };
  }

  let orgId = "";
  let base = "";
  let templateItem = "";
  let skillItem = "";
  let acmeId = "";
  let appItem = "";
  let appInstallId = "";
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
    (await db.selectFrom("directory_items").select("id").execute()).length;

  it("1. 导入：npm 模板、文件技能、官方清单插件、维护任务刷新企业清单；integrity 篡改被拒且什么都没写", async () => {
    // 配置声明的插件待批准（autoApprove 关闭），先批准
    await approve(0, "model-fake");
    await approve(1, "connector-mcp");
    await waitFor(() => loadedOnBoth("model-fake"), 30_000, "model-fake on both", 100);
    await waitFor(() => loadedOnBoth("connector-mcp"), 30_000, "connector-mcp on both", 100);

    // A：从 npm 导入连接器模板
    const tpl = await ok("root", 0, "POST", "/api/v1/admin/directory/import/npm", {
      package: "@acme/github-mcp",
    });
    templateItem = tpl.id as string;
    expect(tpl).toMatchObject({ kind: "connector-template", name: "github-mcp" });
    expect(reg.requests.some((p) => p.includes("github-mcp"))).toBe(true);
    // A：从文件导入技能包
    const sk = await ok(
      "root",
      0,
      "POST",
      "/api/v1/admin/directory/import/file",
      await skillTgz({ name: "@acme/skill-sql-helper", skillName: "sql-helper" }),
    );
    skillItem = sk.id as string;
    expect(sk).toMatchObject({ kind: "skill", name: "sql-helper" });

    // B：刷新官方清单并引入插件条目
    const off = await ok("root", 1, "POST", "/api/v1/admin/catalogs/official/refresh");
    expect(off.lastStatus).toBe("ok");
    const imported = await at(
      "root",
      1,
      "POST",
      "/api/v1/admin/catalogs/official/entries/plugin/example-counter/import",
      { version: "0.1.0" },
    );
    expect(imported.status, JSON.stringify(imported.json)).toBe(201);
    const counterItem = (imported.json.item as { id: string; kind: string }).id;
    // 装到部署（企业管理员批准权限后启用）：后面应用会引用它
    await ok("root", 1, "POST", `/api/v1/admin/directory/items/${counterItem}/install-deployment`, {
      version: "0.1.0",
    });
    expect((await view("example-counter", 1)).status).toBe("pending_approval");
    await approve(1, "example-counter");
    await ok("root", 1, "POST", "/api/v1/admin/plugins/example-counter/enable");
    await waitFor(() => loadedOnBoth("example-counter", "0.1.0"), 30_000, "counter on both", 100);

    // 企业清单：加上后没刷新过、没有条目；维护任务刷新后 A 上能看到；清单再加条目，维护任务再刷新，A 上看到新条目
    const added = await ok("root", 1, "POST", "/api/v1/admin/catalogs", {
      name: "Acme",
      url: acme.url,
    });
    acmeId = added.id as string;
    const entriesOnA = async () =>
      (
        (await ok("root", 0, "GET", `/api/v1/admin/catalogs/entries?sourceId=${acmeId}`)).items as {
          kind: string;
          name: string;
        }[]
      ).map((e) => `${e.kind}/${e.name}`);
    expect(await entriesOnA()).toEqual([]);
    const conn = new Redis(rdc.url, { maxRetriesPerRequest: null });
    const maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: conn });
    try {
      const before = acme.requests.length;
      await maint.add(CATALOGS_REFRESH_JOB, {});
      await waitFor(
        async () => (await entriesOnA()).includes("app/crm-suite"),
        30_000,
        "maintenance refreshed the enterprise catalog",
        200,
      );
      expect(acme.requests.length).toBeGreaterThan(before);
      acme.setIndex(acmeIndex(true));
      await maint.add(CATALOGS_REFRESH_JOB, {});
      await waitFor(
        async () => (await entriesOnA()).includes("skill/tampered"),
        30_000,
        "new entry visible on A",
        200,
      );
    } finally {
      await maint.close();
      conn.disconnect();
    }

    // integrity 被篡改：502 catalog.integrity_mismatch，什么都没写
    const itemsBefore = await itemCount();
    const auditBefore = await db.selectFrom("audit_events").select("id").execute();
    const bad = await at(
      "root",
      0,
      "POST",
      `/api/v1/admin/catalogs/${acmeId}/entries/skill/tampered/import`,
      { version: "1.0.0" },
    );
    expect(bad.status, JSON.stringify(bad.json)).toBe(502);
    expect(errCode(bad)).toBe("catalog.integrity_mismatch");
    expect(await itemCount()).toBe(itemsBefore);
    expect(
      await db.selectFrom("directory_items").select("id").where("name", "=", "tampered").execute(),
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
    await ok("boss", 1, "PUT", `${base}/plugins/example-counter`, { enabled: true });
  });

  it("2. 应用包：引入、一次审阅装到部署（两边不重启加载），B 上组织安装，agent 用到连接器、todo 与技能", async () => {
    const staged = await at(
      "root",
      0,
      "POST",
      `/api/v1/admin/catalogs/${acmeId}/entries/app/crm-suite/import`,
      { version: "1.0.0" },
    );
    expect(staged.status, JSON.stringify(staged.json)).toBe(200);
    const review = staged.json.review as {
      reviewHash: string;
      plugins: { name: string; action: string }[];
      connectorTemplates: { id: string }[];
      skills: { name: string }[];
    };
    expect(review.plugins.map((p) => [p.name, p.action])).toEqual([
      ["todo", "install"],
      ["example-counter", "keep"],
    ]);
    expect(review.connectorTemplates.map((t) => t.id)).toEqual(["docs"]);
    expect(review.skills.map((s) => s.name)).toEqual(["crm-notes"]);
    const confirmed = await ok(
      "root",
      0,
      "POST",
      `/api/v1/admin/directory/apps/${staged.json.stagingId as string}/confirm`,
      { reviewHash: review.reviewHash, deployPlugins: true },
    );
    appItem = (confirmed.item as { id: string }).id;
    expect(confirmed.deploy).toMatchObject([
      { name: "todo", action: "install", result: "enabled" },
    ]);
    // 审阅即批准：todo 不再单独待批准，两个副本都加载
    await waitFor(() => loadedOnBoth("todo", "0.1.0"), 30_000, "todo on both", 100);

    // 组织管理员在 B 上安装应用
    const inst = await at("boss", 1, "POST", `${base}/directory/${appItem}/install`, {
      app: {
        connectors: { docs: { endpoint: { url: mcp.url }, credential: { token: MCP_TOKEN } } },
      },
    });
    expect(inst.status, JSON.stringify(inst.json)).toBe(201);
    appInstallId = (inst.json.installed as { appInstallId: string }).appInstallId;
    const enabled = await db
      .selectFrom("plugin_org_configs")
      .select("plugin")
      .where("org_id", "=", orgId)
      .where("enabled", "=", true)
      .orderBy("plugin")
      .execute();
    expect(enabled.map((r) => r.plugin)).toEqual(["example-counter", "todo"]);
    const conn = await db
      .selectFrom("connectors")
      .select(["id", "slug", "directory_item_id"])
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(conn).toMatchObject({ slug: "docs", directory_item_id: appItem });
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
    const rep = await ok("boss", 0, "DELETE", `${base}/app-installs/${appInstallId}`);
    const byKey = (xs: { kind: string; ref: string }[]) =>
      [...xs].sort((a, b) => `${a.kind}${a.ref}`.localeCompare(`${b.kind}${b.ref}`));
    expect(byKey(rep.kept as { kind: string; ref: string }[])).toEqual([
      { kind: "connector", ref: connectorId, reason: "used_by_agents" },
      { kind: "plugin", ref: "example-counter", reason: "pre_existing" },
    ]);
    expect(byKey(rep.removed as { kind: string; ref: string }[])).toEqual([
      { kind: "plugin", ref: "todo" },
      { kind: "skill", ref: appSkillId },
    ]);
    const enabled = await db
      .selectFrom("plugin_org_configs")
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
    expect((await ok("boss", 1, "GET", `${base}/app-installs`)).installs).toEqual([]);
    // agent 仍能运行：连接器工具照常可用
    const conv = await newConv("boss", 1, agentId);
    const r = await call("boss", 0, conv, "docs__search", { q: "after" }, 1);
    expect(r.isError, String(r.content)).toBe(false);
    expect(String(r.content)).toContain("hits for after");
  });

  it("4. 策略与申请：模板两级审批后才能安装；成员申请技能批准后入库；customConnectors deny 时自建 403", async () => {
    await ok("root", 0, "PUT", `/api/v1/admin/directory/items/${templateItem}/policy`, {
      policy: "needs_approval",
    });
    const connectorBody = {
      connector: {
        name: "GitHub",
        endpoint: { url: mcp.url },
        credential: { token: MCP_TOKEN },
      },
    };
    // 成员申请 → 组织管理员批准：条目需审批且本组织没有授予 → 升级到企业管理员
    const asked = await ok("mem", 0, "POST", `${base}/directory/${templateItem}/requests`, {
      note: "Need GitHub",
    });
    const reqId = (asked.request as { id: string }).id;
    expect(asked.request).toMatchObject({ stage: "org", status: "pending" });
    const orgDecided = await ok("boss", 1, "POST", `${base}/directory-requests/${reqId}/decide`, {
      decision: "approve",
    });
    expect(orgDecided.request).toMatchObject({ stage: "deployment", status: "pending" });
    // 企业管理员批准之前不能安装：202，什么都没建
    const pending = await at("boss", 0, "POST", `${base}/directory/${templateItem}/install`, {
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
    const inboxAdmin = (await ok("root", 1, "GET", "/api/v1/admin/directory/requests"))
      .requests as { id: string }[];
    expect(inboxAdmin.map((r) => r.id)).toEqual([reqId]);
    const decided = await ok(
      "root",
      1,
      "POST",
      `/api/v1/admin/directory/requests/${reqId}/decide`,
      {
        decision: "approve",
      },
    );
    expect(decided.request).toMatchObject({ status: "approved" });
    const installed = await at("boss", 0, "POST", `${base}/directory/${templateItem}/install`, {
      ...connectorBody,
    });
    expect(installed.status, JSON.stringify(installed.json)).toBe(201);
    expect(await liveConnectors()).toHaveLength(2);

    // 成员申请技能 → 组织管理员批准 → 安装入库
    const sk = await ok("mem", 1, "POST", `${base}/directory/${skillItem}/requests`, {});
    const skReq = (sk.request as { id: string }).id;
    const skDecided = await ok("boss", 0, "POST", `${base}/directory-requests/${skReq}/decide`, {
      decision: "approve",
    });
    expect(skDecided.request).toMatchObject({ stage: "org", status: "approved" });
    const skInst = await at("boss", 1, "POST", `${base}/directory/${skillItem}/install`, {});
    expect(skInst.status, JSON.stringify(skInst.json)).toBe(201);
    const lib = (await ok("mem", 0, "GET", `${base}/skills`)).skills as { name: string }[];
    expect(lib.map((s) => s.name)).toContain("sql-helper");

    // customConnectors deny：自建连接器 403（两个副本都一样）
    await ok("root", 1, "PUT", "/api/v1/admin/settings", { customConnectors: "deny" });
    for (const i of [0, 1] as const) {
      const custom = await at("boss", i, "POST", `${base}/connectors`, {
        name: "Mine",
        connector: "mcp",
        endpoint: { url: mcp.url },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: MCP_TOKEN },
      });
      expect(custom.status, JSON.stringify(custom.json)).toBe(403);
      expect(errCode(custom)).toBe("directory.custom_disabled");
    }
    await ok("root", 0, "PUT", "/api/v1/admin/settings", { customConnectors: "allow" });
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
    expect((done.summary as { drifted?: number } | null)?.drifted ?? 0).toBe(0);

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
      .selectFrom("plugin_replica_status")
      .select("replica_id")
      .distinct()
      .execute();
    expect(replicaIds.map((r) => r.replica_id).sort()).toEqual([...bootIds.values()].sort());
  });
});
