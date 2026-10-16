import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDualReplicaHarness, type Harness } from "../src/dual-replica.js";
import { startTestPostgres, type TestContainer } from "../src/index.js";

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

describe("双副本测试工具", () => {
  it("两个副本是不同进程，请求严格交替：第 1、3、5… 次到 replica 0", async () => {
    const h = await harness("whoami");
    const [a, b] = h.replicas;
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).not.toBe(process.pid);
    const pids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.request("/plugins/whoami/pid");
      pids.push(((await r.json()) as { pid: number }).pid);
    }
    expect(pids).toEqual([a.pid, b.pid, a.pid, b.pid, a.pid, b.pid]);
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

  it("插件启动失败时 start 以 stderr 尾部 reject，且不泄露配置", async () => {
    await expect(
      createDualReplicaHarness({ plugins: ["/nonexistent/plugin.ts"], pgUrl: pgc.url }),
    ).rejects.toThrow(/replica failed to start[\s\S]*cannot import plugin/);
  });
});
