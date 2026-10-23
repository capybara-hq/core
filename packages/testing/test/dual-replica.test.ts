import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  runnerArgv,
  runnerEnv,
} from "../src/dual-replica.js";
import { startTestPostgres, startTestRedis, type TestContainer } from "../src/index.js";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
const harnesses: Harness[] = [];

beforeAll(async () => {
  pgc = await startTestPostgres();
});

// 每个 harness 用完立刻停：默认自带 Redis 容器，不跨 harness 共用
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.stop()));
});

afterAll(async () => {
  await pgc?.stop();
});

async function harness(plugin: string): Promise<Harness> {
  const h = await createDualReplicaHarness({ plugins: [fx(plugin)], pgUrl: pgc.url });
  harnesses.push(h);
  return h;
}

/** 同一场景：调 inc 4 次后读 count。 */
async function scenario(h: Harness, name: string): Promise<number> {
  for (let i = 0; i < 4; i++) {
    const r = await h.request(`/plugins/${name}/inc`, { method: "POST" });
    expect(r.status).toBe(200);
  }
  const r = await h.request(`/plugins/${name}/count`);
  return ((await r.json()) as { count: number }).count;
}

// 每个用例都起两个副本子进程（迁移 + 插件宿主收敛）：全量并行跑时 5s 的本地默认值不够
describe("双副本测试工具", { timeout: 60_000 }, () => {
  it("两个副本是不同进程，请求严格交替：第 1、3、5… 次到 replica 0", async () => {
    const h = await harness("whoami");
    const [a, b] = h.replicas;
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).not.toBe(process.pid);
    const pids: number[] = [];
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.request("/plugins/whoami/pid");
      seen.push(r.replica);
      expect(replicaOf(r)).toBe(r.replica);
      pids.push(((await r.json()) as { pid: number }).pid);
    }
    expect(pids).toEqual([a.pid, b.pid, a.pid, b.pid, a.pid, b.pid]);
    // 响应头 x-capybara-replica 标明落点（runner 设置 http.replicaId）
    expect(seen).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("per-replica roles: request() goes only to api replicas; requestTo reaches any replica", async () => {
    const h = await createDualReplicaHarness({
      plugins: [fx("whoami")],
      pgUrl: pgc.url,
      roles: [["api"], ["gateway"]],
    });
    harnesses.push(h);
    const [a, b] = h.replicas;
    expect(a.roles).toEqual(["api"]);
    expect(b.roles).toEqual(["gateway"]);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) seen.push((await h.request("/plugins/whoami/pid")).replica);
    expect(seen).toEqual([0, 0, 0, 0]);
    // The gateway replica serves plugin routes too (servePlugins = api || gateway)
    const r = await h.requestTo(1, "/plugins/whoami/pid");
    expect(r.replica).toBe(1);
    expect(((await r.json()) as { pid: number }).pid).toBe(b.pid);
    await expect(h.requestTo(2, "/healthz")).rejects.toThrow(/no replica 2/);
  });

  it("startExtraReplica: index 2, api replicas join request(), kill() and stop() reach it", async () => {
    const h = await createDualReplicaHarness({
      plugins: [fx("whoami")],
      pgUrl: pgc.url,
      roles: [["api"], ["gateway"]],
    });
    harnesses.push(h);
    expect(h.redisUrl).toMatch(/^redis:\/\//);
    const gw = await h.startExtraReplica(["gateway"]);
    expect(gw.index).toBe(2);
    expect(gw.roles).toEqual(["gateway"]);
    const api = await h.startExtraReplica(["api"]);
    expect(api.index).toBe(3);
    const pids = new Set([...h.replicas.map((r) => r.pid), gw.pid, api.pid]);
    expect(pids.size).toBe(4);
    // Round-robin over the api replicas: 0 and 3
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) seen.push((await h.request("/plugins/whoami/pid")).replica);
    expect(seen).toEqual([0, 3, 0, 3]);
    const r = await h.requestTo(2, "/plugins/whoami/pid");
    expect(((await r.json()) as { pid: number }).pid).toBe(gw.pid);
    await gw.kill();
    expect(alive(gw.pid)).toBe(false);
    await expect(h.requestTo(2, "/healthz")).rejects.toThrow(/replica 2 .*signal SIGKILL/);
    await h.stop();
    expect(alive(api.pid)).toBe(false);
    await expect(h.startExtraReplica(["api"])).rejects.toThrow(/stopped/);
  });

  it("good-counter（ctx.kv）：4 次 inc 后 count 为 4", async () => {
    expect(await scenario(await harness("good-counter"), "good-counter")).toBe(4);
  });

  it("leaky-counter（模块级 Map）：count 不为 4，每个副本只看到 2 次", async () => {
    const count = await scenario(await harness("leaky-counter"), "leaky-counter");
    expect(count).not.toBe(4);
    expect(count).toBe(2);
  });

  it("leaky-sibling（状态在兄弟模块）：count 恰为 2", async () => {
    expect(await scenario(await harness("leaky-sibling"), "leaky-sibling")).toBe(2);
  });

  it("stop 幂等，且子进程都已退出", async () => {
    const h = await harness("good-counter");
    const pids = h.replicas.map((r) => r.pid);
    await h.stop();
    await h.stop();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kill(i)：SIGKILL 该副本，之后发往它的请求抛错，另一个副本照常；stop 仍幂等", async () => {
    const h = await harness("whoami");
    const [a, b] = h.replicas;
    await h.kill(0);
    expect(alive(a.pid)).toBe(false);
    expect(alive(b.pid)).toBe(true);
    // 第 1 次请求落到 replica 0（已死）→ 抛错；第 2 次落到 replica 1 → 正常
    await expect(h.request("/plugins/whoami/pid")).rejects.toThrow(/replica 0 .*signal SIGKILL/);
    const r = await h.request("/plugins/whoami/pid");
    expect(((await r.json()) as { pid: number }).pid).toBe(b.pid);
    await h.kill(0);
    await h.stop();
    expect(alive(b.pid)).toBe(false);
  });

  it("插件启动失败时 start 以 stderr 尾部 reject，且不泄露配置", async () => {
    await expect(
      createDualReplicaHarness({ plugins: ["/nonexistent/plugin.ts"], pgUrl: pgc.url }),
    ).rejects.toThrow(/replica failed to start[\s\S]*cannot import plugin/);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runnerArgv", () => {
  it(".ts runner 带 tsx 与源码条件；.js runner 直接 node", () => {
    expect(runnerArgv("/x/replica-runner.ts")).toEqual([
      "--import",
      "tsx",
      "--conditions=@capybara-hq/source",
      "/x/replica-runner.ts",
    ]);
    expect(runnerArgv("/x/replica-runner.js")).toEqual(["/x/replica-runner.js"]);
  });

  it(".ts runner 的环境指定仓库 tsconfig.base.json；.js runner 环境原样", () => {
    const env = { A: "1" };
    const ts = runnerEnv("/x/replica-runner.ts", env);
    expect(ts.A).toBe("1");
    expect(ts.TSX_TSCONFIG_PATH).toBe(
      fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)),
    );
    expect(existsSync(ts.TSX_TSCONFIG_PATH as string)).toBe(true);
    expect(runnerEnv("/x/replica-runner.js", env)).toEqual({ A: "1" });
  });
});

describe("双副本测试工具：进程与解析", { timeout: 60_000 }, () => {
  it("裸包名插件按 resolveFrom 解析，两个副本都可用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-resolve-"));
    try {
      const pkg = join(dir, "node_modules/@capybara-hq/plugin-tmp2");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@capybara-hq/plugin-tmp2",
          version: "0.1.0",
          type: "module",
          main: "index.js",
        }),
      );
      writeFileSync(
        join(pkg, "index.js"),
        `export default {
  name: "tmp2", version: "0.1.0", sdk: "^0.1.0", provides: [],
  permissions: { http: [{ method: "GET", path: "/ok" }] },
  setup(ctx) { ctx.http.route("GET", "/ok", async () => new Response("ok")); },
};
`,
      );
      const h = await createDualReplicaHarness({
        plugins: ["@capybara-hq/plugin-tmp2"],
        resolveFrom: dir,
        pgUrl: pgc.url,
      });
      harnesses.push(h);
      for (let i = 0; i < 2; i++) {
        const r = await h.request("/plugins/tmp2/ok");
        expect(await r.text()).toBe("ok");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("副本崩溃后 request 以副本序号与退出信息 reject", async () => {
    const h = await harness("good-counter");
    process.kill(h.replicas[1].pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    await h.request("/healthz");
    await expect(h.request("/healthz")).rejects.toThrow(/replica 1 .*SIGKILL/);
  });

  it("相对路径的 resolveFrom 按调用方 cwd 解析（副本进程 cwd 不同）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-resolve-rel-"));
    try {
      const pkg = join(dir, "node_modules/@capybara-hq/plugin-tmp3");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@capybara-hq/plugin-tmp3",
          version: "0.1.0",
          type: "module",
          main: "index.js",
        }),
      );
      writeFileSync(
        join(pkg, "index.js"),
        `export default {
  name: "tmp3", version: "0.1.0", sdk: "^0.1.0", provides: [],
  permissions: { http: [{ method: "GET", path: "/ok" }] },
  setup(ctx) { ctx.http.route("GET", "/ok", async () => new Response("ok")); },
};
`,
      );
      const h = await createDualReplicaHarness({
        plugins: ["@capybara-hq/plugin-tmp3"],
        resolveFrom: relative(process.cwd(), dir),
        pgUrl: pgc.url,
      });
      harnesses.push(h);
      const r = await h.request("/plugins/tmp3/ok");
      expect(await r.text()).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("父进程被 SIGKILL 后两个副本自行退出，不留孤儿", async () => {
    const rd = await startTestRedis();
    let parent: ReturnType<typeof spawn> | undefined;
    let pids: number[] = [];
    try {
      parent = spawn(
        process.execPath,
        [
          ...runnerArgv("x.ts").slice(0, 3),
          fileURLToPath(new URL("./fixtures/orphan-parent.ts", import.meta.url)),
        ],
        {
          stdio: ["ignore", "pipe", "inherit"],
          env: { ...process.env, TEST_PG_URL: pgc.url, TEST_REDIS_URL: rd.url },
        },
      );
      let out = "";
      parent.stdout?.on("data", (b) => {
        out += b;
      });
      const p = parent;
      await new Promise((r) => p.once("exit", r));
      pids = JSON.parse(out.trim().split("\n").pop() as string) as number[];
      expect(pids).toHaveLength(2);
      const deadline = Date.now() + 20_000;
      while (pids.some(alive) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 200));
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      // 失败时也不在 CI 留下残留进程
      for (const pid of [...pids, parent?.pid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已退出
        }
      }
      await rd.stop();
    }
  }, 60_000);
});
