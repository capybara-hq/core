import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAnonymousGuest } from "../../src/channels/threads.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { PLUGIN_UNLOADED_TOOL_ERROR } from "../../src/extensions/inflight.js";
import { fakeSandboxMeta } from "../fixtures/plugins/sandbox-fake/index.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { bootstrapFixture, packFake, sandboxFakePkg } from "../helpers/plugin-packages.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";

/**
 * M6 第二段验收（双副本）：两个独立进程的内核副本（api / worker）共享 PG / Redis / 插件目录，
 * `extensionPermissions.autoApprove: false`；引导插件 fake-object-store（核心假扩展，SeaweedFS，起初没配）、配置声明的 model-fake 与
 * deploycfg；其余插件经后台安装。全部经 HTTP（「卡住工具调用」用测试连接锁表；匿名访客由渠道产生，这里直接建）。
 *
 * 1. 副本 A 上传打包好的 sandbox@1 假插件 v1（敏感）与假扩展 fake-tools-ui v1，副本 B 安装、批准、启用：两个副本都加载，不重启；
 * 2. fake-tools-ui 的工具调用卡在处理函数里（锁住它写的表）时在 A 上升级到 v2（带扩展迁移）：迁移只执行一次；在途调用超过
 *    `drainSeconds` 按 `PLUGIN_UNLOADED_TOOL_ERROR` 中止；运行照常 `completed`；之后的调用落到 v2；
 * 3. 停用 fake-tools-ui：两个副本上都不可用；再启用：又可用；
 * 4. 部署配置：文件里的字段 409；hot 字段跨副本就地生效；非 hot 字段两边都重新加载；
 * 5. 组织沙箱覆盖：之后新建的沙箱拿到覆盖的 cpu，已有沙箱不变；
 * 6. 组织覆盖 `eval` 用途：两个副本看到的生效映射与评委估算都按覆盖；
 * 7. 访客行改角色 → 409 `member.anonymous_guest`；
 * 8. 引导插件：不进待批准；对象存储没配时 `pending_config`、存储不可用；在 A 上配好后两个副本都不重启地加载，存储可用。
 *
 * 「不重启」：副本 id（`<hostname>-<pid>-<6 位随机>`，每次内核启动重新生成）与子进程 pid 从头到尾不变。
 */

const DEPLOYCFG = fileURLToPath(new URL("../fixtures/plugins/deploycfg/index.ts", import.meta.url));
const MAX_BYTES = 8 * 1024 * 1024;
const DRAIN_SECONDS = 3;
const TAGS_MIGRATION =
  "-- v2 的扩展迁移：只建新表并写一行（执行次数 = 行数）。\n" +
  "CREATE TABLE IF NOT EXISTS item_tags (id serial PRIMARY KEY, tag text NOT NULL);\n" +
  "INSERT INTO item_tags (tag) VALUES ('seed');\n";
const V2_MARK = "List updated by fake-tools-ui 0.2.0";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const writeInput = (text: string) => ({
  items: [{ text, status: "pending" }],
});

type Json = Record<string, unknown>;
interface View {
  name: string;
  source: string;
  status: string;
  version: string;
  sha256: string | null;
  reviewHash: string;
  sensitive: boolean;
  replicas: {
    replicaId: string;
    state: string;
    reason: string | null;
    version: string;
    servingVersion: string | null;
  }[];
}
type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>["payload"];

describe("M6 第二段双副本验收（管理后台与免重启插件生命周期）", { timeout: 180_000 }, () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let s3: TestS3;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
  let pluginsDir: string;
  let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
  let sandboxRoot: string;
  let toolsUiV1: Uint8Array;
  let toolsUiV2: Uint8Array;
  let sandboxPkg: Uint8Array;
  /** 启动时两个副本的副本 id（序号 → id）。 */
  const bootIds = new Map<0 | 1, string>();
  const bootPids: number[] = [];
  const jar = new Map<string, string>();

  async function at(i: 0 | 1, method: string, path: string, body?: unknown) {
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
  const ok = async (i: 0 | 1, method: string, path: string, body?: unknown) => {
    const r = await at(i, method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json;
  };
  const errCode = (r: { json: Json }) => (r.json.error as { code?: string } | undefined)?.code;
  const view = async (name: string, i: 0 | 1 = 0) =>
    (await ok(i, "GET", `/api/v1/admin/extensions/${name}`)) as unknown as View;
  const listPlugins = async (i: 0 | 1) =>
    ((await ok(i, "GET", "/api/v1/admin/extensions")).extensions as View[]) ?? [];
  const approve = async (i: 0 | 1, name: string) => {
    const v = await view(name, i);
    await ok(i, "POST", `/api/v1/admin/extensions/${name}/approve`, {
      sha256: v.sha256,
      reviewHash: v.reviewHash,
    });
  };
  /** 副本 id → 序号。 */
  const replicaIndex = (replicaId: string): 0 | 1 | undefined => {
    const pid = Number(/-(\d+)-[0-9a-f]{6}$/.exec(replicaId)?.[1]);
    return pid === h.replicas[0].pid ? 0 : pid === h.replicas[1].pid ? 1 : undefined;
  };
  /** 两个副本（且都是启动时的那两个副本 id）的状态行都在 `version` 上 loaded。 */
  const rowsLoaded = (v: View, version?: string) => {
    const rows = v.replicas.filter(
      (r) => r.state === "loaded" && (version === undefined || r.version === version),
    );
    const ids = new Set(rows.map((r) => r.replicaId));
    return ids.has(bootIds.get(0) ?? "") && ids.has(bootIds.get(1) ?? "");
  };
  /** 两个启动时的副本都把 `pending` 版本记为待批准（approval），同时仍在服务 `serving` 版本。 */
  const servingOnBoth = (v: View, serving: string, pending: string) =>
    [0, 1].every((i) =>
      v.replicas.some(
        (r) =>
          r.replicaId === bootIds.get(i as 0 | 1) &&
          r.state === "pending" &&
          r.reason === "approval" &&
          r.version === pending &&
          r.servingVersion === serving,
      ),
    );
  /** 两个副本都在 `version` 上 loaded，且部署状态 enabled。 */
  const loadedOnBoth = async (name: string, version?: string) => {
    const v = await view(name);
    return v.status === "enabled" && rowsLoaded(v, version) ? v : undefined;
  };
  const unloadedOnBoth = async (name: string) => {
    const v = await view(name);
    return (
      v.status === "disabled" &&
      [0, 1].every((i) =>
        v.replicas.some((r) => r.replicaId === bootIds.get(i as 0 | 1) && r.state === "unloaded"),
      )
    );
  };

  beforeAll(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), "cap-m6s2-plugins-"));
    sandboxRoot = await mkdtemp(join(tmpdir(), "cap-m6s2-sandbox-"));
    // the object store is a bootstrap plugin (as the image carries one), not configured yet
    bootstrap = await bootstrapFixture([{ bytes: await packFake("fake-object-store") }]);
    [pgc, rdc, s3, toolsUiV1, toolsUiV2, sandboxPkg] = await Promise.all([
      startTestPostgres(),
      startTestRedis(),
      startTestS3(),
      packFake("fake-tools-ui"),
      packFake("fake-tools-ui", async (dir) => {
        // v2：升版本、换一处结果文案（看调用落在哪个版本上）、加一条扩展迁移；工具定义不变
        const pkgPath = join(dir, "package.json");
        const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
        await writeFile(pkgPath, JSON.stringify({ ...pkg, version: "0.2.0" }, null, 2));
        const manifestPath = join(dir, ".capybara-plugin", "plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
        await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "0.2.0" }, null, 2));
        const srcPath = join(dir, "src", "index.ts");
        const src = await readFile(srcPath, "utf8");
        const next = src
          .replace('version: "0.1.0"', 'version: "0.2.0"')
          .replace("`List updated (", `\`${V2_MARK} (`);
        expect(next).toContain(V2_MARK);
        expect(next).toContain('version: "0.2.0"');
        await writeFile(srcPath, next);
        await writeFile(join(dir, "migrations", "0002_item_tags.sql"), TAGS_MIGRATION);
      }),
      sandboxFakePkg(),
    ]);
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, DEPLOYCFG],
      bootstrap,
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] },
        "sandbox-fake": { root: sandboxRoot },
        // region 在启动配置（文件）里：后台只读
        deploycfg: { endpoint: "https://file.example", region: "eu" },
      },
      config: {
        auth: { cookieSecure: false },
        extensionPermissions: { autoApprove: false },
        extensionHost: {
          dir: pluginsDir,
          reconcileIntervalSeconds: 2,
          drainSeconds: DRAIN_SECONDS,
        },
        packages: { maxBytes: MAX_BYTES },
      },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    await accountsFor(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      enterpriseAdmin: true,
    });
    const r = await at(0, "POST", "/api/v1/auth/login", { login: "root", password: PW });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // 启动时各副本的副本 id（引导的对象存储待配置，两边各有一行）
    await waitFor(
      async () => {
        const rows = await db
          .selectFrom("extension_replica_status")
          .select("replica_id")
          .where("plugin", "=", "fake-object-store")
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
    await h?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop()]);
    await bootstrap?.cleanup();
    for (const d of [pluginsDir, sandboxRoot]) if (d) await rm(d, { recursive: true, force: true });
  }, 120_000);

  let orgId: string;
  let base: string;
  let agentId: string;
  let firstConv: string;

  const send = async (i: 0 | 1, convId: string, key: string, input: unknown) => {
    const r = await at(i, "POST", `${base}/conversations/${convId}/messages`, {
      text: `tool:${key}:${JSON.stringify(input)}`,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
  };
  const newConv = async (i: 0 | 1) =>
    ((await ok(i, "POST", `${base}/conversations`, { agentId })).conversation as { id: string }).id;
  /** 第 n 个终态（须为 run_finished completed）对应运行的最后一条 tool_result。 */
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
  const orgPluginAvailable = async (i: 0 | 1, name: string) => {
    const plugins = (await ok(i, "GET", `${base}/extensions`)).extensions as {
      plugin: string;
      available: boolean;
    }[];
    return plugins.find((p) => p.plugin === name)?.available;
  };

  it("1. A 上传 sandbox 假插件（敏感）与 fake-tools-ui，B 安装、批准、启用：两个副本都加载，不重启", async () => {
    // 配置声明的插件待批准；引导插件预先批准，不在待批准里
    const before = await listPlugins(0);
    const pending = before.filter((p) => p.status === "pending_approval").map((p) => p.name);
    expect(pending.sort()).toEqual(["deploycfg", "model-fake"]);
    expect(before.find((p) => p.name === "fake-object-store")).toMatchObject({
      source: "install",
      installSource: "bootstrap",
      required: true,
      status: "pending_config",
    });
    await approve(1, "model-fake");

    const sb = (await ok(0, "POST", "/api/v1/admin/extensions/packages/file", sandboxPkg)) as {
      sha256: string;
    };
    const td = (await ok(0, "POST", "/api/v1/admin/extensions/packages/file", toolsUiV1)) as {
      sha256: string;
    };
    expect(sb.sha256).toBe(sha(sandboxPkg));
    expect(td.sha256).toBe(sha(toolsUiV1));
    await ok(1, "POST", "/api/v1/admin/extensions/sandbox-fake/install", { sha256: sb.sha256 });
    await ok(1, "POST", "/api/v1/admin/extensions/fake-tools-ui/install", { sha256: td.sha256 });
    const sbView = await view("sandbox-fake", 1);
    expect(sbView).toMatchObject({ status: "pending_approval", sensitive: true });
    expect((await view("fake-tools-ui", 1)).status).toBe("pending_approval");
    await approve(1, "sandbox-fake");
    await approve(1, "fake-tools-ui");
    await ok(1, "POST", "/api/v1/admin/extensions/sandbox-fake/enable");
    await ok(1, "POST", "/api/v1/admin/extensions/fake-tools-ui/enable");
    await waitFor(() => loadedOnBoth("sandbox-fake", "0.1.0"), 30_000, "sandbox on both", 100);
    await waitFor(
      () => loadedOnBoth("fake-tools-ui", "0.1.0"),
      30_000,
      "fake-tools-ui v1 on both",
      100,
    );
    await waitFor(() => loadedOnBoth("model-fake"), 30_000, "model-fake on both", 100);

    const org = await ok(0, "POST", "/api/v1/orgs", { name: "Acme" });
    orgId = (org.org as { id: string }).id;
    base = `/api/v1/orgs/${orgId}`;
    await ok(1, "PUT", `${base}/extensions/fake-tools-ui`, { enabled: true });
    await waitFor(
      async () => (await orgPluginAvailable(0, "fake-tools-ui")) === true,
      10_000,
      "org",
      100,
    );
    const ag = await ok(0, "POST", `${base}/agents`, {
      definition: {
        name: "Worker",
        instructions: "Use the tools.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "plugin", plugin: "fake-tools-ui", name: "write" },
          { kind: "builtin", name: "sandbox_bash" },
        ],
      },
      visibility: "org",
    });
    agentId = (ag.agent as { id: string }).id;
    // 先跑通一次 v1，确认它在工作
    firstConv = await newConv(1);
    await send(0, firstConv, "fake-tools-ui__write", writeInput("warm up"));
    const r = await finished(firstConv, 1);
    expect(r.isError, String(r.content)).toBe(false);
    expect(String(r.content)).toContain("List updated (1 items)");
  });

  it("2. 调用卡在处理函数里时升级到 v2：迁移一次、在途调用按卸下错误中止、运行完成、之后落到 v2", async () => {
    const lock = new pg.Client({ connectionString: h.dbUrl });
    await lock.connect();
    let locked = true;
    try {
      // 锁住 fake-tools-ui 写的表：处理函数的 upsert 卡在 PG 上，不理会中止
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE plugin_fake_tools_ui.items IN EXCLUSIVE MODE");
      const convId = await newConv(0);
      await send(1, convId, "fake-tools-ui__write", writeInput("stuck"));
      await waitFor(
        async () => (await eventsOf(db, convId)).some((e) => e.type === "tool_call_started"),
        20_000,
        "tool call started",
        50,
      );
      await waitFor(
        async () => {
          const r = await lock.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query ILIKE '%"items"%' AND datname = current_database()`,
          );
          return (r.rows[0]?.n ?? 0) > 0;
        },
        20_000,
        "handler blocked on the table lock",
        50,
      );

      const up = (await ok(0, "POST", "/api/v1/admin/extensions/packages/file", toolsUiV2)) as {
        sha256: string;
      };
      await ok(0, "POST", "/api/v1/admin/extensions/fake-tools-ui/install", { sha256: up.sha256 });
      // v2 多了表权限：待批准，两边都还在 v1
      await waitFor(
        async () => (await view("fake-tools-ui")).status === "pending_approval",
        20_000,
        "v2 pending approval",
        100,
      );
      // 待批准由快照推导，立即生效；副本行要等各自下一次 reconcile（2 秒一轮）才变：在那之前是 loaded 0.1.0，
      // 之后是 pending（approval）0.2.0、仍在服务 0.1.0。两种都算「还在 v1」；等两边都报告了 v2 待批准再往下走，
      // 不赌断言落在 reconcile 之前还是之后
      await waitFor(
        async () => servingOnBoth(await view("fake-tools-ui"), "0.1.0", "0.2.0"),
        20_000,
        "both replicas report v2 pending while serving v1",
        100,
      );
      const approvedAt = Date.now();
      await approve(0, "fake-tools-ui");
      await waitFor(
        () => loadedOnBoth("fake-tools-ui", "0.2.0"),
        30_000,
        "fake-tools-ui v2 on both",
        100,
      );

      // 在途调用：锁一直没放，处理函数没有结束 → 排空时限到了按卸下错误中止
      const result = await waitFor(
        async () => (await eventsOf(db, convId)).find((e) => e.type === "tool_result"),
        DRAIN_SECONDS * 1000 + 20_000,
        "in-flight call aborted",
        100,
      );
      expect(Date.now() - approvedAt).toBeGreaterThanOrEqual(DRAIN_SECONDS * 1000 - 500);
      expect(result.payload).toMatchObject({ isError: true, content: PLUGIN_UNLOADED_TOOL_ERROR });
      // 运行继续到 completed
      const term = await waitForTerminal(db, convId, 1, 30_000);
      expect(term[0]?.type).toBe("run_finished");
      expect(term[0]?.payload).toMatchObject({ reason: "completed" });
      await lock.query("COMMIT");
      locked = false;

      // 迁移只执行一次
      const tags = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM plugin_fake_tools_ui.item_tags`.execute(db);
      expect(tags.rows[0]?.n).toBe(1);
      const row = await db
        .selectFrom("extension_installs")
        .select("migrated_sha")
        .where("name", "=", "fake-tools-ui")
        .executeTakeFirstOrThrow();
      expect(row.migrated_sha).toBe(sha(toolsUiV2));

      // 之后的调用落到 v2（两个副本都只有 v2）
      await send(0, convId, "fake-tools-ui__write", writeInput("after"));
      const next = await finished(convId, 2);
      expect(next.isError, String(next.content)).toBe(false);
      expect(String(next.content)).toContain(`${V2_MARK} (1 items)`);
    } finally {
      if (locked) await lock.query("ROLLBACK").catch(() => undefined);
      await lock.end();
    }
  });

  it("3. 停用 fake-tools-ui：两个副本上都不可用；再启用：又可用", async () => {
    // 起点：fake-tools-ui v2 已批准并在两边加载（第 2 条中途失败时补上批准，失败不连锁到这里和第 8 条）
    if ((await view("fake-tools-ui")).status === "pending_approval")
      await approve(0, "fake-tools-ui");
    await waitFor(
      () => loadedOnBoth("fake-tools-ui", "0.2.0"),
      30_000,
      "fake-tools-ui v2 on both (start)",
      100,
    );
    await ok(0, "POST", "/api/v1/admin/extensions/fake-tools-ui/disable");
    await waitFor(
      () => unloadedOnBoth("fake-tools-ui"),
      30_000,
      "fake-tools-ui unloaded on both",
      100,
    );
    expect(await orgPluginAvailable(0, "fake-tools-ui")).toBe(false);
    expect(await orgPluginAvailable(1, "fake-tools-ui")).toBe(false);
    const c = await newConv(1);
    await send(1, c, "fake-tools-ui__write", writeInput("off"));
    const off = await finished(c, 1);
    expect(off.isError).toBe(true);
    expect(String(off.content)).toContain('Tool "fake-tools-ui__write" is unavailable');

    await ok(1, "POST", "/api/v1/admin/extensions/fake-tools-ui/enable");
    await waitFor(
      () => loadedOnBoth("fake-tools-ui", "0.2.0"),
      30_000,
      "fake-tools-ui back on both",
      100,
    );
    await waitFor(
      async () =>
        (await orgPluginAvailable(0, "fake-tools-ui")) === true &&
        (await orgPluginAvailable(1, "fake-tools-ui")) === true,
      10_000,
      "available on both replicas",
      100,
    );
    await send(0, c, "fake-tools-ui__write", writeInput("on"));
    const on = await finished(c, 2);
    expect(on.isError, String(on.content)).toBe(false);
    expect(String(on.content)).toContain(V2_MARK);
  });

  it("4. 部署配置：文件里的字段 409；hot 字段跨副本就地生效；非 hot 字段两边都重新加载", async () => {
    interface State {
      setups: number;
      generation: number;
      config: { endpoint: string; region: string; greeting: string; poolSize: number };
    }
    const state = async (i: 0 | 1): Promise<State | number> => {
      const r = await at(i, "GET", "/plugins/deploycfg/state");
      return r.status === 200 ? (r.json as unknown as State) : r.status;
    };
    const both = async (pred: (s: State) => boolean) => {
      const [a, b] = [await state(0), await state(1)];
      return typeof a === "object" && typeof b === "object" && pred(a) && pred(b)
        ? ([a, b] as const)
        : undefined;
    };
    expect(await state(0)).toBe(503);
    await approve(0, "deploycfg");
    const [a0, b0] = await waitFor(
      () => both((s) => s.config.region === "eu"),
      30_000,
      "deploycfg loaded on both",
      100,
    );
    const put = (i: 0 | 1, values: Json) =>
      at(i, "PUT", "/api/v1/admin/extensions/deploycfg/config", { values });

    const readonly = await put(1, { region: "us" });
    expect(readonly.status, JSON.stringify(readonly.json)).toBe(409);
    expect(errCode(readonly)).toBe("extension.config_readonly");
    const cfg = await ok(0, "GET", "/api/v1/admin/extensions/deploycfg/config");
    const fields = cfg.fields as { path: string; source: string }[];
    expect(fields.find((f) => f.path === "region")?.source).toBe("file");

    expect((await put(1, { greeting: "hola" })).status).toBe(200);
    const [a1, b1] = await waitFor(
      () => both((s) => s.config.greeting === "hola"),
      20_000,
      "hot value on both replicas",
      100,
    );
    expect([a1.setups, b1.setups]).toEqual([a0.setups, b0.setups]);
    expect([a1.generation, b1.generation]).toEqual([a0.generation, b0.generation]);

    expect((await put(0, { poolSize: 4 })).status).toBe(200);
    const [a2, b2] = await waitFor(
      () => both((s) => s.config.poolSize === 4),
      20_000,
      "reloaded on both replicas",
      100,
    );
    expect([a2.setups, b2.setups]).toEqual([a0.setups + 1, b0.setups + 1]);
    expect(a2.config.greeting).toBe("hola");
  });

  it("5. 组织沙箱覆盖：之后新建的沙箱拿到覆盖的 cpu，已有的不变", async () => {
    const sandboxOf = async (convId: string) => {
      const row = await db
        .selectFrom("sandboxes")
        .select("handle")
        .where("conversation_id", "=", convId)
        .executeTakeFirstOrThrow();
      return fakeSandboxMeta(sandboxRoot, row.handle?.id ?? "");
    };
    const before = await newConv(0);
    await send(1, before, "sandbox_bash", { description: "Test step", command: "echo one" });
    const r1 = await finished(before, 1);
    expect(r1.isError, String(r1.content)).toBe(false);
    expect(String(r1.content)).toContain("one");
    expect((await sandboxOf(before))?.limits).toMatchObject({ cpu: 1, memoryMb: 2048 });

    await ok(0, "PUT", "/api/v1/admin/settings", {
      sandboxLimitOverrides: { [orgId]: { cpu: 2 } },
    });
    const settings = await ok(1, "GET", `${base}/settings`);
    expect(settings.sandboxLimits).toEqual({ cpu: 2, memoryMb: 2048, source: "override" });

    const after = await newConv(1);
    await send(0, after, "sandbox_bash", { description: "Test step", command: "echo two" });
    const r2 = await finished(after, 1);
    expect(r2.isError, String(r2.content)).toBe(false);
    expect((await sandboxOf(after))?.limits).toMatchObject({ cpu: 2, memoryMb: 2048 });
    expect((await sandboxOf(before))?.limits).toMatchObject({ cpu: 1 });
  });

  it("6. 组织覆盖 eval 用途：两个副本上的生效映射与评委估算都按覆盖", async () => {
    // 只给 fake-2 定价：评委成本有值说明评委按 fake-2 估算
    await ok(0, "PUT", "/api/v1/admin/model-prices", {
      provider: "model-fake",
      model: "fake-2",
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    });
    await ok(1, "PUT", "/api/v1/admin/model-purposes/eval", {
      target: { model: { provider: "model-fake", model: "fake-1" } },
    });
    const set = await ok(0, "POST", `${base}/eval-sets`, { agentId, name: "Segment 2" });
    const setId = (set.set as { id: string }).id;
    await ok(1, "POST", `${base}/eval-sets/${setId}/cases/sample`, { count: 1 });
    const body = {
      mode: "step",
      candidate: { model: { provider: "model-fake", model: "fake-1" } },
      judge: true,
    };
    const estimate = async (i: 0 | 1) =>
      (await ok(i, "POST", `${base}/eval-sets/${setId}/runs/estimate`, body)).estimate as {
        judgeRequests: number;
        judgeCost: number | null;
      };
    const e0 = await estimate(1);
    expect(e0.judgeRequests).toBeGreaterThan(0);
    expect(e0.judgeCost).toBeNull();

    await ok(0, "PUT", `${base}/model-purposes/eval`, {
      target: { model: { provider: "model-fake", model: "fake-2" } },
    });
    for (const i of [0, 1] as const) {
      const purposes = (await ok(i, "GET", `${base}/model-purposes`)).purposes as {
        purpose: string;
        default: { model: { model: string } } | null;
        override: { model: { model: string } } | null;
        effective: { model: { model: string } } | null;
      }[];
      const ev = purposes.find((p) => p.purpose === "eval");
      expect(ev?.default?.model.model).toBe("fake-1");
      expect(ev?.override?.model.model).toBe("fake-2");
      expect(ev?.effective?.model.model).toBe("fake-2");
      const e = await estimate(i);
      expect(e.judgeCost, JSON.stringify(e)).toBeGreaterThan(0);
    }
  });

  it("7. 访客行改角色：409 member.anonymous_guest", async () => {
    const guestId = await ensureAnonymousGuest(db, orgId);
    for (const i of [0, 1] as const) {
      const r = await at(i, "PATCH", `${base}/members/${guestId}`, { role: "member" });
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(errCode(r)).toBe("member.anonymous_guest");
    }
  });

  it("8. 引导插件：不进待批准；对象存储没配时 pending_config、存储不可用；在 A 上配好后两边都不重启地加载", async () => {
    const all = await listPlugins(1);
    expect(all.filter((p) => p.status === "pending_approval").map((p) => p.name)).toEqual([]);
    expect(all.find((p) => p.name === "fake-object-store")).toMatchObject({
      source: "install",
      installSource: "bootstrap",
      required: true,
      status: "pending_config",
    });
    const attach = (i: 0 | 1, name: string, bytes: Buffer) =>
      at(i, "POST", `${base}/attachments`, {
        name,
        contentType: "text/plain",
        size: bytes.length,
      });
    for (const i of [0, 1] as const) {
      const r = await attach(i, "x.txt", Buffer.from("x"));
      expect(r.status, JSON.stringify(r.json)).toBe(503);
      expect(errCode(r)).toBe("storage.unavailable");
    }

    await ok(0, "PUT", "/api/v1/admin/extensions/fake-object-store/config", {
      values: {
        endpoint: s3.endpoint,
        region: s3.region,
        bucket: s3.bucket,
        accessKeyId: s3.accessKey,
        secretAccessKey: s3.secretKey,
        forcePathStyle: true,
      },
    });
    await waitFor(
      () => loadedOnBoth("fake-object-store"),
      30_000,
      "object store loaded on both",
      100,
    );
    // 两个副本都能用存储：各自签发直传、上传、finalize
    for (const i of [0, 1] as const) {
      const bytes = Buffer.from(`hello from replica ${i}\n`);
      const c = await attach(i, `r${i}.txt`, bytes);
      expect(c.status, JSON.stringify(c.json)).toBe(201);
      const up = c.json.upload as {
        method: "PUT" | "POST";
        url: string;
        headers: Record<string, string>;
        fields?: Record<string, string>;
      };
      let res: Response;
      if (up.method === "PUT") {
        res = await fetch(up.url, { method: "PUT", headers: up.headers, body: bytes });
      } else {
        const form = new FormData();
        for (const [k, v] of Object.entries(up.fields ?? {})) form.append(k, v);
        form.append("file", new Blob([new Uint8Array(bytes)], { type: "text/plain" }));
        res = await fetch(up.url, { method: "POST", headers: up.headers, body: form });
      }
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      const other: 0 | 1 = i === 0 ? 1 : 0;
      const f = await at(other, "POST", `${base}/attachments/${c.json.id as string}/finalize`);
      expect(f.status, JSON.stringify(f.json)).toBe(200);
    }

    // 从头到尾没有重启：子进程与副本 id 都没变
    expect([h.replicas[0].pid, h.replicas[1].pid]).toEqual(bootPids);
    const ids = await db
      .selectFrom("extension_replica_status")
      .select("replica_id")
      .distinct()
      .execute();
    expect(ids.map((r) => r.replica_id).sort()).toEqual([...bootIds.values()].sort());
  });
});
