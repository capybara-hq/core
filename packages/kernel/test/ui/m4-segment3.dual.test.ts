import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { type PermissionSet, permissionKeys } from "../../src/extensions/permission-set.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, waitForTerminal } from "../helpers/runs.js";
import { openSse, type SseClient, uiFrames } from "../helpers/sse.js";

/**
 * M4 第三段验收（双副本：两个独立进程的内核副本，共享 PG / Redis / 主密钥）：
 *
 *  1. todo 视图跨副本实时刷新：`todo__write` 在某个副本的 worker 上执行，**两个**副本上打开的对话 SSE
 *     都收到 `event: ui`（所以另一个副本一定是经 Redis bus 收到的），两个副本取到的 `tasks` 视图
 *     都是新的 badge 与 checklist。
 *  2. view / embed 的批准规则（spec §4.1、§5.4，审查重点 5）：副本以 ui-a 0.1.0 运行（快照已写入共享 PG），
 *     模拟滚动升级中重启的副本（同一个库，`autoApprove` 关闭）：
 *     - 升级到只多一个 view 的 0.2.0 → 不需要批准照常加载，快照补上 `ui.view:tasks`；
 *     - 再升级到多一个 embed 的 0.3.0 → 待批准、不加载、快照不变；`capybara plugins review` 把它列出并标 `(sensitive)`。
 *  3. 嵌入令牌：副本 0 签发的令牌在副本 1 上只对签给的插件有效（签给 ui-probe 的令牌 example-board 不认）；
 *     组织停用插件后立即失效；当 Bearer 调内核 `/api` 一律 401。
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const UI_PROBE = fixture("ui-probe");
const UI_A = fixture("ui-a");
const UI_A_VIEW = fixture("ui-a-view");
const UI_A_EMBED = fixture("ui-a-embed");
const TODO = fileURLToPath(new URL("../../../../plugins/todo/src/index.ts", import.meta.url));
const BOARD = fileURLToPath(
  new URL("../../../../plugins/example-board/src/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let cookie = "";
let orgId = "";
let base = "";
const sses: SseClient[] = [];

type Json = Record<string, unknown>;

const at = async (
  i: 0 | 1,
  method: string,
  path: string,
  body?: unknown,
  auth?: { bearer: string } | { cookie: string },
) => {
  const c = auth !== undefined && "cookie" in auth ? auth.cookie : cookie;
  const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
    method,
    headers: {
      ...(auth !== undefined && "bearer" in auth
        ? { authorization: `Bearer ${auth.bearer}` }
        : { "x-capybara-csrf": "1", ...(c !== "" && { cookie: c }) }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  expect(replicaOf(res)).toBe(i);
  const text = await res.text();
  return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
};

const openStream = async (i: 0 | 1, path: string, headers: Record<string, string>) => {
  const s = await openSse(`http://127.0.0.1:${h.replicas[i].port}${path}`, headers);
  sses.push(s);
  return s;
};

const errCode = (r: { json: Json }) => (r.json.error as { code?: string } | undefined)?.code;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  h = await createDualReplicaHarness({
    plugins: [MODEL_FAKE, TODO, BOARD, UI_PROBE, UI_A],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    config: { auth: { cookieSecure: false } },
  });
  raw = createDb(h.dbUrl, 3);
  db = kernelDb(raw);

  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "o" });
  const login = await h.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "x-capybara-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ login: "owner", password: PW }),
  });
  expect(login.status).toBe(200);
  await login.body?.cancel();
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const org = await at(0, "POST", "/api/v1/orgs", { name: "Acme" });
  orgId = (org.json.org as { id: string }).id;
  base = `/api/v1/orgs/${orgId}`;
  for (const [i, plugin] of [
    [1, "todo"],
    [0, "example-board"],
    [1, "ui-probe"],
  ] as const) {
    const en = await at(i, "PUT", `${base}/extensions/${plugin}`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
  }
}, 180_000);

afterAll(async () => {
  for (const s of sses) s.close();
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

describe("M4 第三段验收（双副本）", () => {
  it("todo：一个副本执行 todo__write，两个副本的对话 SSE 都收到 event: ui，视图是新的 badge 与清单", async () => {
    const ag = await at(0, "POST", `${base}/agents`, {
      definition: {
        name: "Planner",
        instructions: "Plan the work.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "todo", name: "write" }],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const conv = await at(1, "POST", `${base}/conversations`, {
      agentId: (ag.json.agent as { id: string }).id,
    });
    const convId = (conv.json.conversation as { id: string }).id;

    // 写入前：两个副本上都是空清单
    for (const i of [0, 1] as const) {
      const v = await at(i, "GET", `${base}/ui/views/todo/tasks?conversationId=${convId}`);
      expect(v.status, JSON.stringify(v.json)).toBe(200);
      expect(v.json.view).toEqual({ badge: "0/0", blocks: [{ type: "checklist", items: [] }] });
    }

    // 两个副本各开一条对话 SSE：工具只在其中一个副本上执行，另一个只能经 Redis bus 收到刷新
    const streams = await Promise.all(
      ([0, 1] as const).map((i) =>
        openStream(i, `${base}/conversations/${convId}/stream`, { cookie }),
      ),
    );
    for (const s of streams) expect(s.status).toBe(200);

    const todos = {
      todos: [
        { content: "Design", status: "completed", activeForm: "Designing" },
        { content: "Review", status: "completed", activeForm: "Reviewing" },
        { content: "Build", status: "in_progress", activeForm: "Building" },
        { content: "Ship", status: "pending", activeForm: "Shipping" },
      ],
    };
    const sent = await at(0, "POST", `${base}/conversations/${convId}/messages`, {
      text: `tool:todo__write:${JSON.stringify(todos)}`,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(202);
    await waitForTerminal(db, convId, 1, 30_000);

    await Promise.all(
      streams.map((s, i) =>
        s.until(
          (m) => uiFrames(m).some((f) => f.plugin === "todo" && f.contribution === "tasks"),
          10_000,
          `todo tasks frame on replica ${i}`,
        ),
      ),
    );
    for (const s of streams) {
      expect(uiFrames(s.messages)).toEqual([{ plugin: "todo", contribution: "tasks" }]);
    }

    for (const i of [0, 1] as const) {
      const v = await at(
        i,
        "GET",
        `${base}/ui/views/todo/tasks?conversationId=${convId}&locale=zh`,
      );
      expect(v.status).toBe(200);
      expect(v.json.view).toEqual({
        badge: "2/4",
        blocks: [
          {
            type: "checklist",
            items: [
              { text: "Design", status: "completed" },
              { text: "Review", status: "completed" },
              { text: "Building", status: "in_progress" },
              { text: "Ship", status: "pending" },
            ],
          },
        ],
      });
    }

    // 工具调用的显示摘要随 tool_result 进日志（对话流里那一行的说明）
    const results = await db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", convId)
      .where("type", "=", "tool_result")
      .execute();
    expect(results.map((r) => (r.payload as { display?: unknown }).display)).toEqual([
      { summary: { zh: "更新任务清单（4 项）", en: "Updated task list (4 items)" } },
    ]);
  }, 90_000);

  it("批准规则：升级只多 view 照常加载、快照补上；多 embed 待批准，plugins review 标 (sensitive)", async () => {
    // 两个副本以 ui-a 0.1.0 运行（harness 默认 autoApprove，快照已写入共享库）
    const snapshot = async () =>
      db
        .selectFrom("extension_permission_snapshots")
        .selectAll()
        .where("plugin", "=", "ui-a")
        .executeTakeFirstOrThrow();
    const before = await snapshot();
    expect(before.version).toBe("0.1.0");
    expect(permissionKeys(before.permissions as PermissionSet)).toEqual([
      "permissions.http:GET /ui/board",
    ]);

    // 滚动升级中重启的副本：同一个库与 Redis，生产配置（autoApprove 关闭）
    const redis = new Redis(rdc.url);
    const sub = createBusSubscriber(() => new Redis(rdc.url));
    const deps: KernelDeps = {
      db: createDb(h.dbUrl, 2),
      dbUrl: h.dbUrl,
      redis,
      busSubscriber: sub,
      redisUrl: rdc.url,
      keyring: createKeyring(Buffer.alloc(32, 9), []),
      runWorkers: false,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const hosts: ExtensionHost[] = [];
    const boot = async (plugin: string) => {
      const host = new ExtensionHost(deps, {}, { autoApprove: false });
      hosts.push(host);
      await host.load([plugin]);
      return host;
    };
    try {
      // 只多一个 view：不卡加载，快照补上 ui.view:tasks（来源不变）
      const upgraded = await boot(UI_A_VIEW);
      expect(upgraded.manifests().map((m) => `${m.name}@${m.version}`)).toEqual(["ui-a@0.2.0"]);
      expect(upgraded.pending()).toEqual([]);
      const afterView = await snapshot();
      expect(afterView.version).toBe("0.2.0");
      expect(afterView.source).toBe(before.source);
      expect(permissionKeys(afterView.permissions as PermissionSet)).toEqual([
        "permissions.http:GET /ui/board",
        "ui.view:tasks",
      ]);
      // 另外两个副本（仍是 0.1.0）不受影响，照常服务
      const still = await at(1, "GET", `${base}/ui/contributions`);
      expect(still.status).toBe(200);

      // 多一个 embed：待批准、不加载，快照不变
      const blocked = await boot(UI_A_EMBED);
      expect(blocked.manifests()).toEqual([]);
      expect(blocked.pending()).toEqual([
        {
          plugin: "ui-a",
          version: "0.3.0",
          reason: "added",
          added: ["ui.embed:board"],
          removed: [],
        },
      ]);
      expect((await snapshot()).version).toBe("0.2.0");
    } finally {
      await Promise.all(hosts.map((x) => x.close()));
      await sub.close();
      redis.disconnect();
      await deps.db.destroy();
    }

    // 部署级审阅：`capybara plugins review` 列出 0.3.0 并把 embed 标为敏感
    const review = await runCli(["plugins", "review"], [UI_A_EMBED]);
    expect(review.code, review.stderr).toBe(0);
    expect(review.stdout).toContain(
      "ui-a 0.3.0: awaiting approval (permissions added since the approved snapshot)",
    );
    expect(review.stdout).toContain("  + ui.embed:board  (sensitive)");
    // 已经进了快照的 view 不再列出
    expect(review.stdout).not.toContain("ui.view:tasks");

    // 只多 view 的版本：plugins review 没有待批准项
    const viewOnly = await runCli(["plugins", "review"], [UI_A_VIEW]);
    expect(viewOnly.code, viewOnly.stderr).toBe(0);
    expect(viewOnly.stdout).toContain("No plugins await permission approval.");
  }, 120_000);

  it("嵌入令牌：副本 0 签发、副本 1 只对本插件有效；停用插件后失效；调 /api 得 401", async () => {
    const issue = async (i: 0 | 1, plugin: string, id: string) => {
      const r = await at(i, "POST", `${base}/ui/embeds/${plugin}/${id}/token`, {});
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json as { token: string; src: string; expiresAt: string; expiresIn: number };
    };
    const board = await issue(0, "example-board", "board");
    expect(board.src).toBe("/plugin-ui/example-board/board");
    expect(board.expiresIn).toBe(300);
    const probe = await issue(0, "ui-probe", "board");

    // 副本 1 上校验：签给 example-board 的令牌通过，签给 ui-probe 的被拒
    const created = await at(
      1,
      "POST",
      "/plugins/example-board/ui/cards",
      { title: "Ship" },
      {
        bearer: board.token,
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const listed = await at(1, "GET", "/plugins/example-board/ui/cards", undefined, {
      bearer: board.token,
    });
    expect(listed.status).toBe(200);
    expect((listed.json.cards as { title: string }[]).map((c) => c.title)).toEqual(["Ship"]);
    const wrong = await at(1, "GET", "/plugins/example-board/ui/cards", undefined, {
      bearer: probe.token,
    });
    expect(wrong.status).toBe(401);
    const wrongStream = await openStream(1, "/plugins/example-board/ui/events", {
      authorization: `Bearer ${probe.token}`,
    });
    expect(wrongStream.status).toBe(401);

    // 内核 /api 不认嵌入令牌（两个副本都是）
    for (const i of [0, 1] as const) {
      for (const path of ["/api/v1/me", `${base}/ui/contributions`, `${base}/agents`]) {
        const r = await at(i, "GET", path, undefined, { bearer: board.token });
        expect(r.status, `${path} on replica ${i}`).toBe(401);
        expect(errCode(r)).toBe("auth.required");
      }
    }

    // 组织在副本 0 停用 example-board → 副本 1 上的已签出令牌立即失效（verifyEmbedToken 每次查启用状态）
    const off = await at(0, "PUT", `${base}/extensions/example-board`, { enabled: false });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    for (const i of [0, 1] as const) {
      const r = await at(i, "GET", "/plugins/example-board/ui/cards", undefined, {
        bearer: board.token,
      });
      expect(r.status, `replica ${i}`).toBe(401);
    }
    const offStream = await openStream(1, "/plugins/example-board/ui/events", {
      authorization: `Bearer ${board.token}`,
    });
    expect(offStream.status).toBe(401);
    // 停用期间也签不出新令牌
    const refused = await at(1, "POST", `${base}/ui/embeds/example-board/board/token`, {});
    expect(refused.status).toBe(404);
    expect(errCode(refused)).toBe("ui.not_found");

    // 重新启用后同一个令牌（未过期）恢复有效
    const on = await at(1, "PUT", `${base}/extensions/example-board`, { enabled: true });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    const back = await at(0, "GET", "/plugins/example-board/ui/cards", undefined, {
      bearer: board.token,
    });
    expect(back.status).toBe(200);
  }, 60_000);
});

/** 以子进程执行 `pnpm capybara <args>`（部署级 CLI），连 harness 的库；Redis 给不可达地址（plugins 命令不连它）。 */
function runCli(
  args: string[],
  plugins: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CAPYBARA_")) env[k] = v;
  Object.assign(env, {
    CAPYBARA_DB__URL: h.dbUrl,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    CAPYBARA_PLUGINS: JSON.stringify(plugins),
  });
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
