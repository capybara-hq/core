import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDualReplicaHarness, type Harness } from "../src/dual-replica.js";
import { startTestPostgres, startTestRedis, type TestContainer } from "../src/index.js";

const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
const harnesses: Harness[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
});

afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.stop()));
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function harness(plugin: string): Promise<Harness> {
  const h = await createDualReplicaHarness({
    plugins: [fx(plugin)],
    pgUrl: pgc.url,
    redisUrl: rd.url,
  });
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
  it("request 严格交替：第 1、3、5… 次到 replica 0", async () => {
    const h = await harness("good-counter");
    const hits: number[] = [];
    h.replicas.forEach((k, i) => {
      const orig = k.app.request.bind(k.app);
      vi.spyOn(k.app, "request").mockImplementation((...a: Parameters<typeof orig>) => {
        hits.push(i);
        return orig(...a);
      });
    });
    for (let i = 0; i < 6; i++) await h.request("/healthz");
    expect(hits).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("good-counter（ctx.kv）：4 次 inc 后 count 为 4", async () => {
    expect(await scenario(await harness("good-counter"), "good-counter")).toBe(4);
  });

  it("leaky-counter（模块级 Map）：count 不为 4，每个副本只看到 2 次", async () => {
    const count = await scenario(await harness("leaky-counter"), "leaky-counter");
    expect(count).not.toBe(4);
    expect(count).toBe(2);
  });

  it("stop 幂等，并且两个副本都已停止", async () => {
    const h = await harness("good-counter");
    await h.stop();
    await h.stop();
    for (const k of h.replicas) expect(k.port).toBeUndefined();
  });
});
