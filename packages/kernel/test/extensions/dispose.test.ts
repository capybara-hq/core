import { fileURLToPath } from "node:url";
import { ExtensionPointUnavailableError, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBusSubscriber } from "../../src/ctx/bus.js";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import {
  ImportTracker,
  loadInstance,
  ManifestMismatchError,
  UPGRADE_WARN_THRESHOLD,
} from "../../src/extensions/instance.js";
import type { PermissionSet } from "../../src/extensions/permission-set.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { diamondD } from "../fixtures/plugins/diamond-d/index.js";
import everythingModule, { everythingProbe } from "../fixtures/plugins/everything/index.js";
import { consumerProbe } from "../fixtures/plugins/everything-consumer/index.js";
import { dependentProbe } from "../fixtures/plugins/everything-dependent/index.js";
import { hangReload } from "../fixtures/plugins/hang-reload/index.js";

/**
 * 注册追踪与撤销（T12，C17）的单副本测试：everything 插件把每一种登记都做一遍，
 * 撤销后逐项确认已撤销、没有遗留，重新加载后逐项确认又能用了。
 */

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let rd: Awaited<ReturnType<typeof startTestRedis>>;
let deps: KernelDeps;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let jobsQueue: Queue;
let jobsConn: Redis;
const hosts: ExtensionHost[] = [];
const warned: { msg: string; fields: Record<string, unknown> | undefined }[] = [];

const fx = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));
const EVERYTHING = fx("everything");
const CONSUMER = fx("everything-consumer");
const DEPENDENT = fx("everything-dependent");

const host = (
  cfg: Record<string, unknown> = {},
  opts: Partial<ConstructorParameters<typeof ExtensionHost>[2]> = {},
) => {
  const h = new ExtensionHost(deps, cfg, {
    registry: new ExtensionRegistry(),
    autoApprove: true,
    drainMs: () => 1_000,
    ...opts,
  });
  hosts.push(h);
  return h;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

const LOCK_KEY = "cap:everything:lock:held";
const BUS_CHANNEL = "cap:everything:ping";
const subscribers = async () =>
  Number(((await redis.pubsub("NUMSUB", BUS_CHANNEL)) as [string, number])[1]);

beforeAll(async () => {
  [pg, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  deps = {
    db: createDb(pg.url, 5),
    dbUrl: pg.url,
    redis,
    busSubscriber: sub,
    redisUrl: rd.url,
    keyring: createKeyring(Buffer.alloc(32, 1), []),
    runWorkers: true,
    log: {
      info() {},
      warn: (msg: string, fields?: Record<string, unknown>) => warned.push({ msg, fields }),
      error() {},
    },
  };
  jobsConn = new Redis(rd.url, { maxRetriesPerRequest: null });
  jobsQueue = new Queue("cap.everything.jobs", { connection: jobsConn });
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
afterAll(async () => {
  await jobsQueue.close();
  jobsConn.disconnect();
  await sub.close();
  redis.disconnect();
  await deps.db.destroy();
  await Promise.all([pg.stop(), rd.stop()]);
});

describe("插件撤销：每一种登记", () => {
  it("撤销后逐项消失、没有遗留；重新加载后逐项恢复", async () => {
    const probe = everythingProbe();
    const consumer = consumerProbe();
    const h = host();
    await h.load([EVERYTHING, CONSUMER]);
    const first = h.current("everything");
    expect(first?.generation).toBe(1);
    // 账上有每一种登记
    expect(new Set(first?.registrations().map((r) => r.kind))).toEqual(
      new Set(["tool", "route", "queue", "bus", "lease", "ui.view", "ui.action", "provide"]),
    );
    expect(h.tools().map((t) => `${t.plugin}:${t.spec.name}`)).toEqual([
      "everything:hang",
      "everything:polite",
    ]);
    expect(h.routes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /plugins/everything/hello",
    ]);
    expect(h.list("counter").map((e) => e.plugin)).toEqual(["everything"]);
    expect(h.uiContributions().map((c) => [c.plugin, !!c.render, !!c.action])).toEqual([
      ["everything", true, true],
    ]);
    expect(await subscribers()).toBe(1);
    expect(await redis.exists(LOCK_KEY)).toBe(1);
    expect(await jobsQueue.getWorkersCount()).toBe(1);
    await jobsQueue.add("jobs", { n: 1 });
    await waitFor(() => probe.jobs.length === 1, "first job");
    expect(consumer.setups).toBe(1);
    const firstCtx = probe.ctxs[0];

    // ---- 撤销 ----
    const removed = await h.unload("everything");
    expect(removed).toEqual(["everything"]);
    expect(h.current("everything")).toBeUndefined();
    expect(first?.registrations()).toEqual([]);
    expect(h.tools()).toEqual([]);
    expect(h.routes()).toEqual([]);
    expect(await h.unavailable("everything")).toBe(true);
    expect(await h.unavailable("nobody")).toBe(false);
    expect(h.list("counter")).toEqual([]);
    expect(h.uiContributions()).toEqual([]);
    expect(await subscribers()).toBe(0);
    await redis.publish(BUS_CHANNEL, JSON.stringify({ after: "dispose" }));
    expect(await redis.exists(LOCK_KEY)).toBe(0);
    expect(await jobsQueue.getWorkersCount()).toBe(0);
    // 撤销期间入队的任务留在队列里，新实例接着处理
    await jobsQueue.add("jobs", { n: 2 });
    await sleep(300);
    expect(probe.jobs).toEqual([{ n: 1 }]);
    expect(probe.messages).toEqual([]);
    expect(probe.disposed).toBe(1);
    expect(probe.disposeSawAborted).toEqual([true]);
    expect(firstCtx?.signal.aborted).toBe(true);
    // 旧 ctx 不能再登记
    await expect(firstCtx?.bus.subscribe("ping", () => {})).rejects.toThrow();
    // optional 依赖方在本副本重新加载：取 everything 的能力抛 ExtensionPointUnavailableError
    expect(consumer.setups).toBe(2);
    const consumerCtx = consumer.ctxs[1];
    expect(() => consumerCtx?.extensionPoints.get("counter@1", "everything")).toThrow(
      ExtensionPointUnavailableError,
    );
    expect(consumer.seen[1]).toEqual([]);

    // ---- 重新加载 ----
    const second = await h.reload("everything");
    expect(second.generation).toBe(2);
    expect(h.current("everything")).toBe(second);
    expect(await h.unavailable("everything")).toBe(false);
    expect(h.tools().map((t) => t.spec.name)).toEqual(["hang", "polite"]);
    expect(h.routes().map((r) => r.path)).toEqual(["/plugins/everything/hello"]);
    expect(h.uiContributions()).toHaveLength(1);
    expect(await subscribers()).toBe(1);
    expect(await redis.exists(LOCK_KEY)).toBe(1);
    await waitFor(async () => (await jobsQueue.getWorkersCount()) === 1, "new worker");
    await waitFor(() => probe.jobs.length === 2, "left-over job handled by the new instance");
    expect(probe.jobs[1]).toEqual({ n: 2 });
    await redis.publish(BUS_CHANNEL, JSON.stringify({ hi: 1 }));
    await waitFor(() => probe.messages.length === 1, "bus message");
    expect(probe.messages).toEqual([{ hi: 1 }]);
    expect(consumer.setups).toBe(3);
    expect(consumer.ctxs[2]?.extensionPoints.get("counter@1", "everything")).toMatchObject({
      from: "everything",
    });
  }, 30_000);

  it("requires 的依赖方随提供方卸下（dependency），提供方回来后重新加载", async () => {
    const dep = dependentProbe();
    const before = { setups: dep.setups, disposed: dep.disposed };
    const h = host();
    await h.load([EVERYTHING, DEPENDENT]);
    expect(dep.setups).toBe(before.setups + 1);
    const removed = await h.unload("everything");
    expect(removed.sort()).toEqual(["everything", "everything-dependent"]);
    expect(h.current("everything-dependent")).toBeUndefined();
    expect(dep.disposed).toBe(before.disposed + 1);
    await h.reload("everything");
    expect(h.current("everything-dependent")).toBeDefined();
    expect(dep.setups).toBe(before.setups + 2);
  }, 30_000);

  it("setup 抛错：已登记的全部撤销", async () => {
    const probe = everythingProbe();
    const disposedBefore = probe.disposed;
    const h = host({ everything: { failAfterRegister: true } });
    await expect(h.load([EVERYTHING])).rejects.toThrow(/setup failed after registering/);
    expect(h.current("everything")).toBeUndefined();
    expect(h.tools()).toEqual([]);
    expect(h.list("counter")).toEqual([]);
    expect(await subscribers()).toBe(0);
    expect(await redis.exists(LOCK_KEY)).toBe(0);
    expect(await jobsQueue.getWorkersCount()).toBe(0);
    // setup 没有成功，不调用插件的 dispose；ctx.signal 已中止
    expect(probe.disposed).toBe(disposedBefore);
    expect(probe.ctxs.at(-1)?.signal.aborted).toBe(true);
  }, 30_000);

  it("同一入口的重新加载不算升级、不告警；不同入口数超过 20 时告警一次", async () => {
    const h = host();
    await h.load([EVERYTHING]);
    warned.length = 0;
    for (let i = 0; i < UPGRADE_WARN_THRESHOLD + 1; i++) await h.reload("everything");
    expect(warned.filter((x) => x.msg.includes("until the process restarts"))).toEqual([]);
    const t = new ImportTracker();
    for (let i = 0; i < 25; i++) expect(t.record("p", "file:///p/a.mjs")).toBe(false);
    expect(t.upgrades).toBe(0);
    const warns: number[] = [];
    for (let i = 1; i <= UPGRADE_WARN_THRESHOLD + 3; i++) {
      if (t.record("p", `file:///p/v${i}.mjs`)) warns.push(t.upgrades);
    }
    expect(warns).toEqual([UPGRADE_WARN_THRESHOLD + 1]);
  }, 60_000);

  it("理会 ctx.signal 的队列任务在排空时限内正常结束，ctx.signal 不会提前中止", async () => {
    const probe = everythingProbe();
    const h = host();
    await h.load([EVERYTHING]);
    const conn = new Redis(rd.url, { maxRetriesPerRequest: null });
    const slow = new Queue("cap.everything.slowjobs", { connection: conn });
    try {
      const startedBefore = probe.slowStarted;
      const doneBefore = probe.slowDone.length;
      await slow.add("slowjobs", {});
      await waitFor(() => probe.slowStarted === startedBefore + 1, "slow job started");
      await h.unload("everything", { drainMs: 5_000 });
      expect(probe.slowDone.slice(doneBefore)).toEqual([{ aborted: false }]);
      expect(probe.ctxs.at(-1)?.signal.aborted).toBe(true);
    } finally {
      await slow.close();
      conn.disconnect();
    }
  }, 30_000);

  it("插件 dispose() 卡住：按时限记日志后继续，后续 unload / reload 不被卡住", async () => {
    const h = host({}, { disposeTimeoutMs: () => 200 });
    await h.load([fx("hang-dispose")]);
    warned.length = 0;
    const t0 = Date.now();
    await h.unload("hang-dispose");
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(warned.some((w) => w.msg.includes("dispose() did not finish in time"))).toBe(true);
    await h.reload("hang-dispose");
    await h.reload("hang-dispose");
    expect(await h.unload("hang-dispose")).toEqual(["hang-dispose"]);
  }, 30_000);

  it("重新加载时 setup 卡住：按时限失败、旧实例保留；卡住的 reload 不拖住 close()", async () => {
    const p = hangReload();
    try {
      const h = host({}, { reloadSetupTimeoutMs: () => 300 });
      await h.load([fx("hang-reload")]);
      p.hang = true;
      const old = h.current("hang-reload");
      await expect(h.reload("hang-reload")).rejects.toThrow(/did not finish within 300 ms/);
      expect(h.current("hang-reload")).toBe(old);

      p.hang = false;
      const h2 = host({}, { reloadSetupTimeoutMs: () => 60_000 });
      await h2.load([fx("hang-reload")]);
      p.hang = true;
      const pending = h2.reload("hang-reload");
      pending.catch(() => {});
      await sleep(100);
      const t0 = Date.now();
      await h2.close({ lifecycleWaitMs: 200 });
      expect(Date.now() - t0).toBeLessThan(3_000);
      await expect(pending).rejects.toThrow(/closed/);
      expect(h2.current("hang-reload")).toBeUndefined();
      await expect(h2.reload("hang-reload")).rejects.toThrow(/closed/);
      await expect(h2.unload("hang-reload")).rejects.toThrow(/closed/);
    } finally {
      p.hang = false;
    }
  }, 30_000);

  it("菱形依赖：提供方变化时连锁只重新加载每个依赖方一次（拓扑序）", async () => {
    const d = diamondD();
    const h = host();
    await h.load([EVERYTHING, fx("diamond-b"), fx("diamond-c"), fx("diamond-d")]);
    const before = d.setups;
    await h.unload("everything");
    expect(d.setups).toBe(before + 1);
    await h.reload("everything");
    expect(d.setups).toBe(before + 2);
  }, 30_000);

  it("loadInstance：与包内静态清单核对（不一致抛 manifest_mismatch，不 setup），一致则 setup 出实例", async () => {
    const probe = everythingProbe();
    const setupsBefore = probe.setups;
    const deps0 = {
      kernel: deps,
      extensionPointAccess: { providers: () => [], enabledPlugins: async () => new Set<string>() },
      nextGeneration: () => 7,
    };
    const input = {
      entryUrl: new URL("../fixtures/plugins/everything/index.ts", import.meta.url).href,
      source: "install" as const,
      sha256: "0".repeat(64),
      config: { failAfterRegister: false },
      configHash: "0".repeat(16),
      // 只测核对与 setup：权限集合不参与（宿主在此之前过闸门）
      permissions: {} as PermissionSet,
    };
    const reviewed = staticManifestOf(everythingModule);
    await expect(
      loadInstance(deps0, {
        ...input,
        section: { name: "everything", manifest: { ...reviewed, version: "9.9.9" } },
      }),
    ).rejects.toBeInstanceOf(ManifestMismatchError);
    expect(probe.setups).toBe(setupsBefore);
    const inst = await loadInstance(deps0, {
      ...input,
      section: { name: "everything", manifest: reviewed },
    });
    expect(inst.generation).toBe(7);
    expect(inst.registrations().length).toBeGreaterThan(0);
    await inst.dispose({ drainMs: 0 });
    expect(inst.registrations()).toEqual([]);
    expect(await redis.exists(LOCK_KEY)).toBe(0);
    expect(await subscribers()).toBe(0);
  }, 30_000);
});
