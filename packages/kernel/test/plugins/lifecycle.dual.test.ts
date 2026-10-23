import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { lifePkg } from "../helpers/plugin-packages.js";
import { eventsOf, PW, waitFor } from "../helpers/runs.js";

/**
 * 插件免重启生命周期的双副本验收（T14，C16）：两个独立进程的副本共享 PG / Redis 与插件目录；
 * 安装记录插件 `life`（工具 `wait` 等共享目录里的 `release` 文件；路由 `/version` 报告该副本跑的版本）。
 * 全部操作经 HTTP，只有「丢消息」一步直接改 PG（不发布）。周期 reconcile 设为 2 秒。
 *
 * 1. 上传 v1 → 安装（停用）→ 网页批准 → 启用：两个副本都加载 v1；
 * 2. 工具调用在途时停用：在途副本排空（调用照常拿到 v1 的结果），之后两边都卸下；
 * 3. 重新启用后升级到带迁移的 v2：迁移只执行一次，两个副本都切到 v2；
 * 4. v3 在副本 B 上 setup 失败：B 继续跑 v2、状态 failed 且列出 B；去掉故障后 B 收敛到 v3；
 * 5. 直接改 PG 停用（不发布消息）：周期任务让两个副本都卸下；
 * 6. 卸载：安装记录没了，数据保留，两个副本的路由都回到 404。
 */

const MAX_BYTES = 4 * 1024 * 1024;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const HITS = {
  file: "0001_hits.sql",
  sql: "CREATE TABLE IF NOT EXISTS hits (id serial PRIMARY KEY);\nINSERT INTO hits DEFAULT VALUES;\n",
};

type Json = Record<string, unknown>;
interface View {
  status: string;
  version: string;
  sha256: string | null;
  reviewHash: string;
  desired: { version: string; sha256: string; state: string } | null;
  replicas: { replicaId: string; state: string; reason: string | null; version: string }[];
}

describe("插件生命周期双副本验收", { timeout: 120_000 }, () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let redis: Redis;
  let gateDir: string;
  let pluginsDir: string;
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
      ...(body !== undefined && {
        body: binary ? Buffer.from(body) : JSON.stringify(body),
      }),
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
  const view = async (i: 0 | 1 = 0) =>
    (await ok(i, "GET", "/api/v1/admin/plugins/life")) as unknown as View;
  const upload = async (bytes: Uint8Array) =>
    (await ok(1, "POST", "/api/v1/admin/plugins/packages/file", bytes)) as { sha256: string };
  const approve = async () => {
    const v = await view(1);
    await ok(0, "POST", "/api/v1/admin/plugins/life/approve", {
      sha256: v.sha256,
      reviewHash: v.reviewHash,
    });
  };
  /** 副本行 → 副本序号（副本 id 为 `<hostname>-<pid>-<6 位随机>`）。 */
  const replicaIndex = (replicaId: string): 0 | 1 | undefined => {
    const pid = Number(/-(\d+)-[0-9a-f]{6}$/.exec(replicaId)?.[1]);
    return pid === h.replicas[0].pid ? 0 : pid === h.replicas[1].pid ? 1 : undefined;
  };
  const rowOf = (v: View, i: 0 | 1) => v.replicas.find((r) => replicaIndex(r.replicaId) === i);
  /** 某个副本此刻跑的版本（插件路由；不在该副本生效时 503 / 404）。 */
  const versionAt = async (i: 0 | 1) => {
    const r = await at(i, "GET", "/plugins/life/version");
    return r.status === 200 ? String(r.json.text ?? JSON.stringify(r.json)) : r.status;
  };
  const both = async (want: string | number) =>
    (await versionAt(0)) === want && (await versionAt(1)) === want;

  beforeAll(async () => {
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    redis = new Redis(rdc.url);
    await redis.flushdb();
    gateDir = await mkdtemp(join(tmpdir(), "cap-life-gate-"));
    pluginsDir = await mkdtemp(join(tmpdir(), "cap-life-plugins-"));
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      pluginConfig: { life: { dir: gateDir }, "model-fake": { models: [{ id: "fake-1" }] } },
      config: {
        auth: { cookieSecure: false },
        pluginPermissions: { autoApprove: false },
        pluginHost: { dir: pluginsDir, reconcileIntervalSeconds: 2, drainSeconds: 30 },
        packages: { maxBytes: MAX_BYTES },
      },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    await new AccountsService(db).createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      enterpriseAdmin: true,
    });
    const r = await at(0, "POST", "/api/v1/auth/login", { login: "root", password: PW });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    redis?.disconnect();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
    for (const d of [gateDir, pluginsDir]) if (d) await rm(d, { recursive: true, force: true });
  }, 120_000);

  let orgId: string;
  let agentId: string;
  let v2: Uint8Array;
  let v3: Uint8Array;

  it("1. 安装 → 批准 → 启用：两个副本都加载 v1", async () => {
    const v1 = await lifePkg({ version: "1.0.0" });
    const { sha256 } = await upload(v1);
    const installed = (await ok(0, "POST", "/api/v1/admin/plugins/life/install", {
      sha256,
    })) as unknown as View;
    expect(installed.desired).toMatchObject({ state: "disabled", sha256: sha(v1) });
    await approve();
    await ok(1, "POST", "/api/v1/admin/plugins/life/enable");
    await waitFor(() => both("1.0.0"), 20_000, "both replicas on 1.0.0", 100);
    await waitFor(
      async () => {
        const v = await view();
        return (
          v.status === "enabled" &&
          rowOf(v, 0)?.state === "loaded" &&
          rowOf(v, 1)?.state === "loaded"
        );
      },
      20_000,
      "status enabled with two loaded replicas",
      100,
    );

    // 配置声明的 model-fake 同样待批准：在一个副本上网页批准，另一个副本经 plugins.changed 收敛
    const mf = (await ok(0, "GET", "/api/v1/admin/plugins/model-fake")) as unknown as View;
    expect(mf.status).toBe("pending_approval");
    await ok(1, "POST", "/api/v1/admin/plugins/model-fake/approve", {
      sha256: null,
      reviewHash: mf.reviewHash,
    });
    await waitFor(
      async () => {
        const v = (await ok(1, "GET", "/api/v1/admin/plugins/model-fake")) as unknown as View;
        return (
          v.status === "enabled" &&
          rowOf(v, 0)?.state === "loaded" &&
          rowOf(v, 1)?.state === "loaded"
        );
      },
      20_000,
      "model-fake loaded on both replicas",
      100,
    );
    const org = await ok(0, "POST", "/api/v1/orgs", { name: "Acme" });
    orgId = (org.org as { id: string }).id;
    await ok(1, "PUT", `/api/v1/orgs/${orgId}/plugins/life`, { enabled: true });
    const ag = await ok(0, "POST", `/api/v1/orgs/${orgId}/agents`, {
      definition: {
        name: "Waiter",
        instructions: "Call the tool.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "life", name: "wait" }],
      },
      visibility: "org",
    });
    agentId = (ag.agent as { id: string }).id;
  });

  it("2. 工具调用在途时停用：在途副本排空、调用照常结束，之后两边都卸下", async () => {
    const c = await ok(0, "POST", `/api/v1/orgs/${orgId}/conversations`, { agentId });
    const convId = (c.conversation as { id: string }).id;
    await ok(1, "POST", `/api/v1/orgs/${orgId}/conversations/${convId}/messages`, {
      text: "tool:life__wait:{}",
    });
    const started = await waitFor(
      async () => (await readdir(gateDir)).find((f) => f.startsWith("started-1.0.0-")),
      20_000,
      "tool call started",
      50,
    );
    const runner: 0 | 1 = Number(started.split("-").at(-1)) === h.replicas[0].pid ? 0 : 1;
    const other: 0 | 1 = runner === 0 ? 1 : 0;

    await ok(other, "POST", "/api/v1/admin/plugins/life/disable");
    // 另一个副本没有在途调用，很快卸下；在途的副本排空中（状态行还是 loaded，调用未结束）
    await waitFor(
      async () => rowOf(await view(), other)?.state === "unloaded",
      20_000,
      "idle replica unloaded",
      100,
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(rowOf(await view(), runner)?.state).toBe("loaded");
    expect((await eventsOf(db, convId)).some((e) => e.type === "tool_result")).toBe(false);
    // 新请求在两个副本上都已取不到插件
    expect(await versionAt(runner)).toBe(503);

    await writeFile(join(gateDir, "release"), "");
    const result = await waitFor(
      async () => (await eventsOf(db, convId)).find((e) => e.type === "tool_result"),
      20_000,
      "tool result",
      100,
    );
    expect(result.payload).toMatchObject({ isError: false });
    expect(String((result.payload as { content: unknown }).content)).toContain("life 1.0.0 done");
    await waitFor(
      async () => {
        const v = await view();
        return v.status === "disabled" && rowOf(v, runner)?.state === "unloaded";
      },
      20_000,
      "both unloaded, status disabled",
      100,
    );
    await rm(join(gateDir, "release"));
  });

  it("3. 升级到带迁移的 v2：迁移只执行一次，两个副本都切到 v2", async () => {
    await ok(0, "POST", "/api/v1/admin/plugins/life/enable");
    await waitFor(() => both("1.0.0"), 20_000, "both back on 1.0.0", 100);
    v2 = await lifePkg({ version: "2.0.0", migrations: [HITS] });
    const { sha256 } = await upload(v2);
    await ok(1, "POST", "/api/v1/admin/plugins/life/install", { sha256 });
    // v2 多了表权限：待批准，两边都还在 v1
    await waitFor(async () => (await view()).status === "pending_approval", 20_000, "pending", 100);
    expect(await both("1.0.0")).toBe(true);
    await approve();
    await waitFor(() => both("2.0.0"), 30_000, "both replicas on 2.0.0", 100);
    const hits = await sql<{ n: number }>`SELECT count(*)::int AS n FROM plugin_life.hits`.execute(
      db,
    );
    expect(hits.rows[0]?.n).toBe(1);
    const row = await db
      .selectFrom("plugin_installs")
      .select("migrated_sha")
      .where("name", "=", "life")
      .executeTakeFirstOrThrow();
    expect(row.migrated_sha).toBe(sha(v2));
    await waitFor(async () => (await view()).status === "enabled", 20_000, "enabled on v2", 100);
  });

  it("4. v3 在副本 B 上 setup 失败：B 继续跑 v2，状态 failed 并列出 B；去掉故障后收敛到 v3", async () => {
    await writeFile(join(gateDir, `fail-3.0.0-${h.replicas[1].pid}`), "");
    v3 = await lifePkg({ version: "3.0.0", migrations: [HITS] });
    const { sha256 } = await upload(v3);
    await ok(0, "POST", "/api/v1/admin/plugins/life/install", { sha256 });
    await waitFor(async () => (await versionAt(0)) === "3.0.0", 30_000, "A on 3.0.0", 100);
    // A 的路由报 3.0.0 只说明新实例已登记；状态行在登记之后才写 loaded（此前可能还是迁移 busy 时记的
    // pending / migration），所以要等 A 的行也收敛，不在某一刻断言
    const failed = await waitFor(
      async () => {
        const v = await view();
        const a = rowOf(v, 0);
        return v.status === "failed" &&
          rowOf(v, 1)?.state === "failed" &&
          a?.state === "loaded" &&
          a.version === "3.0.0"
          ? v
          : undefined;
      },
      20_000,
      "status failed listing B, A loaded 3.0.0",
      100,
    );
    expect(rowOf(failed, 1)).toMatchObject({ reason: "setup_failed", version: "3.0.0" });
    expect(rowOf(failed, 0)).toMatchObject({ state: "loaded", version: "3.0.0" });
    expect(await versionAt(1)).toBe("2.0.0");

    await rm(join(gateDir, `fail-3.0.0-${h.replicas[1].pid}`));
    await redis.publish("cap:kernel:plugins.reconcile", "{}");
    await waitFor(() => both("3.0.0"), 20_000, "B converged to 3.0.0", 100);
    await waitFor(async () => (await view()).status === "enabled", 20_000, "enabled on v3", 100);
    // 迁移没有再执行（v3 的迁移文件与 v2 相同，已执行过）
    const hits = await sql<{ n: number }>`SELECT count(*)::int AS n FROM plugin_life.hits`.execute(
      db,
    );
    expect(hits.rows[0]?.n).toBe(1);
  });

  it("5. 丢消息：直接改 PG 停用、不发布，周期 reconcile 让两个副本都卸下", async () => {
    const sub = new Redis(rdc.url);
    const seen: string[] = [];
    await sub.subscribe("cap:kernel:plugins.changed");
    sub.on("message", (_ch, m) => seen.push(m));
    try {
      await db
        .updateTable("plugin_installs")
        .set({ desired_state: "disabled" })
        .where("name", "=", "life")
        .execute();
      await waitFor(() => both(503), 30_000, "both replicas unloaded by periodic reconcile", 100);
      expect(seen).toEqual([]);
    } finally {
      sub.disconnect();
    }
    await waitFor(async () => (await view()).status === "disabled", 20_000, "disabled", 100);
  });

  it("6. 卸载：安装记录没了，数据保留，两个副本的路由都回到 404", async () => {
    await ok(1, "DELETE", "/api/v1/admin/plugins/life");
    expect(
      await db.selectFrom("plugin_installs").select("name").where("name", "=", "life").execute(),
    ).toEqual([]);
    await waitFor(() => both(404), 4_000, "route gate 404 on both replicas", 100);
    const hits = await sql<{ n: number }>`SELECT count(*)::int AS n FROM plugin_life.hits`.execute(
      db,
    );
    expect(hits.rows[0]?.n).toBe(1);
    expect(
      await db
        .selectFrom("plugin_permission_snapshots")
        .select("plugin")
        .where("plugin", "=", "life")
        .execute(),
    ).toHaveLength(1);
    expect((await at(0, "GET", "/api/v1/admin/plugins/life")).status).toBe(404);
    expect(existsSync(join(gateDir, "release"))).toBe(false);
  });
});
