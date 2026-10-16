import { startTestRedis } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueue } from "../../src/ctx/queue.js";

let box: Awaited<ReturnType<typeof startTestRedis>>;
const queues: Array<{ close(): Promise<void> }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("until: timeout");
};
const mk = (ns: string, runWorkers = true) => {
  const q = createQueue(box.url, ns, { runWorkers });
  queues.push(q);
  return q;
};

beforeAll(async () => {
  box = await startTestRedis();
});
afterAll(async () => {
  await Promise.all(queues.map((q) => q.close()));
  await box.stop();
});

describe("ctx.queue", () => {
  it("define + add：handler 收到数据", async () => {
    const q = mk("q-basic");
    const got: unknown[] = [];
    q.define<{ n: number }>("work", async (d) => {
      got.push(d);
    });
    await q.add("work", { n: 1 });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ n: 1 });
  });

  it("delayMs：400ms 内未执行，1s 内执行", async () => {
    const q = mk("q-delay");
    let at = 0;
    const t0 = Date.now();
    q.define("d", async () => {
      at = Date.now() - t0;
    });
    await q.add("d", {}, { delayMs: 500 });
    await sleep(400);
    expect(at).toBe(0);
    await until(() => at > 0, 3000);
    expect(at).toBeGreaterThanOrEqual(450);
  });

  it("同 jobId 重复 add 只执行一次", async () => {
    const q = mk("q-dedup");
    let n = 0;
    q.define("j", async () => {
      n++;
    });
    await q.add("j", {}, { jobId: "same" });
    await q.add("j", {}, { jobId: "same" });
    await until(() => n >= 1);
    await sleep(500);
    expect(n).toBe(1);
  });

  it("name / jobId 含 ':' 抛 TypeError", async () => {
    const q = mk("q-val");
    await expect(q.add("a:b", {})).rejects.toThrow(TypeError);
    await expect(q.add("ab", {}, { jobId: "x:y" })).rejects.toThrow(/-/);
    expect(() => q.define("a:b", async () => {})).toThrow(TypeError);
  });

  it("runWorkers=false：add 成功但不执行；由另一实例消费", async () => {
    const producer = mk("q-role", false);
    let ran = 0;
    producer.define("r", async () => {
      ran++;
    });
    await producer.add("r", {});
    await sleep(500);
    expect(ran).toBe(0);
    const consumer = mk("q-role", true);
    let got = 0;
    consumer.define("r", async () => {
      got++;
    });
    await until(() => got === 1);
  });

  it("重复 define 同名抛错", () => {
    const q = mk("q-twice");
    q.define("x", async () => {});
    expect(() => q.define("x", async () => {})).toThrow(/already defined/);
  });

  it("失败任务会重试", async () => {
    const q = mk("q-retry");
    let n = 0;
    q.define("f", async () => {
      n++;
      if (n === 1) throw new Error("once");
    });
    await q.add("f", {});
    await until(() => n === 2, 10_000);
  });

  it("close 等待进行中的任务", async () => {
    const q = createQueue(box.url, "q-close", { runWorkers: true });
    let started = false;
    let done = false;
    q.define("s", async () => {
      started = true;
      await sleep(600);
      done = true;
    });
    await q.add("s", {});
    await until(() => started);
    await q.close();
    expect(done).toBe(true);
  });

  it("close 之后 add / define 抛 closed", async () => {
    const q = createQueue(box.url, "q-closed", { runWorkers: true });
    await q.close();
    await expect(q.add("x", {})).rejects.toThrow(/closed/);
    expect(() => q.define("x", async () => {})).toThrow(/closed/);
  });
});
