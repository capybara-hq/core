import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { WorkerHost } from "@nestjs/bullmq";
import { ModulesContainer } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildKernelApp, closeKernelApp, createKernelApp } from "../../src/app.js";
import { GATEWAY_CHECK_JOB } from "../../src/channels/job-ids.js";
import { CHANNEL_QUEUE_NAME } from "../../src/channels/jobs.js";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { TITLE_QUEUE } from "../../src/conversations/titles.js";
import { EVAL_QUEUE_NAME } from "../../src/evals/jobs.js";
import { PLUGINS_RECONCILE_JOB } from "../../src/extensions/lifecycle-topics.js";
import { LockedIntervalScheduler } from "../../src/infra/schedule/locked-interval.js";
import { LOCKED_JOB } from "../../src/infra/schedule/locked-tick.js";
import { KernelLifecycle } from "../../src/lifecycle/kernel-lifecycle.js";
import { createLogger } from "../../src/log.js";
import { GatewayRole } from "../../src/roles/gateway-role.js";
import { WorkerRole } from "../../src/roles/worker-role.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../../src/runtime/run-jobs.js";
import { USAGE_REPORT_QUEUE } from "../../src/runtime/usage-report.js";
import { WAIT_SWEEP_JOB, WaitSweepJob, Waits } from "../../src/runtime/waits.js";
import { ToolDrift } from "../../src/tools/drift.js";
import { ToolJobs } from "../../src/tools/jobs.js";
import { SLOW_GATES_KEY, type SlowGates } from "../fixtures/plugins/slow/index.js";

const SLOW = fileURLToPath(new URL("../fixtures/plugins/slow/index.ts", import.meta.url));

/**
 * The role modules (nest kernel Task 4.1): `roles` selects ApiModule (controllers), WorkerModule
 * (every cron and queue consumer) and GatewayModule (the channel supervisor and webhook inbound).
 * Each case runs one kernel alone on the shared Redis, so the BullMQ worker count is its own.
 */

const KERNEL_QUEUES = [
  RUN_QUEUE_NAME,
  SUBAGENT_RUN_QUEUE_NAME,
  USAGE_REPORT_QUEUE,
  TITLE_QUEUE,
  EVAL_QUEUE_NAME,
  MAINTENANCE_QUEUE_NAME,
  CHANNEL_QUEUE_NAME,
];

let pgc: TestContainer;
let rd: TestContainer;
let queues: Queue[];
let app: NestFastifyApplication | undefined;
/** The worker-only process's schedules (cron job names, interval names), for the all-roles case. */
let workerSchedules: { crons: string[]; intervals: string[] } | undefined;

const schedulesOf = (a: NestFastifyApplication) => ({
  crons: [...a.get(SchedulerRegistry).getCronJobs().keys()].sort(),
  intervals: a.get(LockedIntervalScheduler).names().sort(),
});

const cfg = (roles: string[], over: Record<string, unknown> = {}): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 3 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles,
    ...over,
  });

async function start(roles: string[]): Promise<NestFastifyApplication> {
  app = await createKernelApp(cfg(roles), {
    env: {},
    logger: createLogger("error", { write: () => {} }),
  });
  return app;
}

/** The application's providers with a `@LockedCron` / `@LockedInterval` job, and its processors. */
function scan(a: NestFastifyApplication): { jobHosts: string[]; processors: string[] } {
  const jobHosts = new Set<string>();
  const processors = new Set<string>();
  for (const mod of a.get(ModulesContainer).values()) {
    for (const wrapper of mod.providers.values()) {
      const instance = wrapper.instance as Record<string, unknown> | null | undefined;
      if (!instance || typeof instance !== "object") continue;
      const name = instance.constructor.name;
      if (instance instanceof WorkerHost) processors.add(name);
      let proto = Object.getPrototypeOf(instance) as object | null;
      while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          const fn = Object.getOwnPropertyDescriptor(proto, key)?.value;
          if (typeof fn === "function" && Reflect.getMetadata(LOCKED_JOB, fn) === true) {
            jobHosts.add(name);
          }
        }
        proto = Object.getPrototypeOf(proto) as object | null;
      }
    }
  }
  return { jobHosts: [...jobHosts].sort(), processors: [...processors].sort() };
}

/** The BullMQ workers connected to the kernel's queues (BullMQ names its worker connections). */
async function bullWorkers(): Promise<number> {
  const counts = await Promise.all(queues.map((q) => q.getWorkersCount()));
  return counts.reduce((a, b) => a + b, 0);
}

/** The kernel's routes, without HEAD / OPTIONS. */
function routes(a: NestFastifyApplication): string[] {
  return a
    .get(KernelLifecycle)
    .http.routes()
    .filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS")
    .map((r) => `${r.method} ${r.url}`)
    .sort();
}

const absent = (a: NestFastifyApplication, token: Parameters<NestFastifyApplication["get"]>[0]) =>
  expect(() => a.get(token)).toThrow();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  queues = KERNEL_QUEUES.map((name) => new Queue(name, { connection: { url: rd.url } }));
}, 120_000);
afterEach(async () => {
  if (app) await closeKernelApp(app);
  app = undefined;
});
afterAll(async () => {
  await Promise.all((queues ?? []).map((q) => q.close()));
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("role modules", () => {
  it("api only: serves the API, runs no cron and no BullMQ worker", async () => {
    const a = await start(["api"]);
    expect(routes(a)).toContain("GET /api/v1/setup");
    expect(routes(a)).not.toContain("POST /channels/webhook/:connectionId");
    expect(scan(a)).toEqual({ jobHosts: [], processors: [] });
    absent(a, SchedulerRegistry);
    absent(a, LockedIntervalScheduler);
    absent(a, WorkerRole);
    absent(a, GatewayRole);
    absent(a, ChannelSupervisor);
    expect(await bullWorkers()).toBe(0);
  }, 60_000);

  it("api only consumes nothing: a job on every kernel queue stays waiting until a worker-role process takes it", async () => {
    const BOUND_MS = 2_000;
    const a = await start(["api"]);
    const tag = `api-only-${Date.now()}`;
    const jobs = await Promise.all(
      queues.map((q) => q.add("probe", { probe: tag }, { jobId: `${tag}-${q.name}`, attempts: 1 })),
    );
    const states = () => Promise.all(jobs.map((j) => j.getState()));
    // every job stays waiting for the whole bound (each state polled throughout, not once)
    const until = Date.now() + BOUND_MS;
    while (Date.now() < until) {
      expect(new Set(await states())).toEqual(new Set(["waiting"]));
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await bullWorkers()).toBe(0);
    await closeKernelApp(a);
    app = undefined;
    // the contrast: a worker-role process takes every one of them well within the same bound
    await start(["worker"]);
    const t0 = Date.now();
    await vi.waitFor(
      async () => {
        for (const st of await states()) expect(st).not.toBe("waiting");
      },
      { timeout: BOUND_MS, interval: 50 },
    );
    expect(Date.now() - t0).toBeLessThan(BOUND_MS);
  }, 60_000);

  it("gateway only: runs the supervisor and the webhook route, no cron and no BullMQ worker", async () => {
    const a = await start(["gateway"]);
    // the extension routes are served by the api and gateway roles (unchanged)
    expect(routes(a).filter((r) => !r.endsWith(" /plugins/*"))).toEqual([
      "GET /healthz",
      "GET /readyz",
      "POST /channels/webhook/:connectionId",
    ]);
    expect(routes(a)).toContain("GET /plugins/*");
    expect(a.get(ChannelSupervisor)).toBeInstanceOf(ChannelSupervisor);
    expect(a.get(GatewayRole)).toBeInstanceOf(GatewayRole);
    expect(scan(a)).toEqual({ jobHosts: [], processors: [] });
    absent(a, SchedulerRegistry);
    absent(a, LockedIntervalScheduler);
    absent(a, WorkerRole);
    expect(await bullWorkers()).toBe(0);
  }, 60_000);

  it("worker only: exposes only the health routes, runs the crons and every queue consumer", async () => {
    const a = await start(["worker"]);
    expect(routes(a)).toEqual(["GET /healthz", "GET /readyz"]);
    absent(a, GatewayRole);
    absent(a, ChannelSupervisor);
    const crons = a.get(SchedulerRegistry).getCronJobs();
    expect([...crons.keys()]).toEqual(expect.arrayContaining([WAIT_SWEEP_JOB, GATEWAY_CHECK_JOB]));
    for (const [name, job] of crons) expect(job.isActive, name).toBe(true);
    expect(a.get(LockedIntervalScheduler).names()).toContain(PLUGINS_RECONCILE_JOB);
    workerSchedules = schedulesOf(a);
    const { jobHosts, processors } = scan(a);
    expect(jobHosts).toEqual([
      "AttachmentCleanupJob",
      "CatalogJobs",
      "DirectoryScanJob",
      "GatewayCheckJob",
      "OffboardSweepJob",
      "PluginsReconcileJob",
      "SandboxSweepJobs",
      "StoragePurgeJob",
      "ToolJobs",
      "UsageSweepJob",
      "WaitSweepJob",
    ]);
    expect(processors).toHaveLength(KERNEL_QUEUES.length);
    for (const q of queues) expect(await q.getWorkersCount(), q.name).toBeGreaterThan(0);
  }, 60_000);

  it("all roles in one process: the same crons and consumers, once each", async () => {
    const a = await start(["api", "worker", "gateway"]);
    const { jobHosts, processors } = scan(a);
    expect(jobHosts).toHaveLength(11);
    // the same cron jobs and intervals as the worker-only process, each registered once
    expect(workerSchedules).toBeDefined();
    expect(schedulesOf(a)).toEqual(workerSchedules);
    expect(a.get(SchedulerRegistry).getCronJobs().size).toBe(workerSchedules?.crons.length);
    expect(processors).toHaveLength(KERNEL_QUEUES.length);
    for (const q of queues) expect(await q.getWorkersCount(), q.name).toBe(1);
    expect(routes(a)).toContain("GET /api/v1/setup");
    expect(routes(a)).toContain("POST /channels/webhook/:connectionId");
  }, 60_000);

  it("R21: no cron or interval tick runs before the worker role started (after the extension load)", async () => {
    const r = new Redis(rd.url);
    try {
      const stale = await r.keys("cron:*");
      if (stale.length > 0) await r.del(...stale);
    } finally {
      r.disconnect();
    }
    let release!: () => void;
    let entered!: () => void;
    const enteredP = new Promise<void>((res) => {
      entered = res;
    });
    const slow: SlowGates = {
      entered: { resolve: () => entered() },
      gate: { promise: new Promise<void>((res) => (release = res)) },
    };
    const key = `roles-r21-${Date.now()}`;
    const g = globalThis as { [SLOW_GATES_KEY]?: Map<string, SlowGates> };
    g[SLOW_GATES_KEY] ??= new Map();
    g[SLOW_GATES_KEY].set(key, slow);
    const lines: { level: string; msg: string }[] = [];
    try {
      const built = await buildKernelApp(
        cfg(["worker"], {
          extensions: [SLOW],
          extensionConfig: { slow: { key } },
          extensionPermissions: { autoApprove: true },
        }),
        {
          env: {},
          logger: createLogger("info", { write: (l) => lines.push(JSON.parse(l)) }),
        },
      );
      app = built;
      // the job bodies: the wait sweep (a @LockedCron) and the drift scan (a @LockedInterval)
      const sweep = vi.fn(async () => 0);
      const scan = vi.fn(async () => 0);
      built.get(Waits).sweep = sweep as never;
      built.get(ToolDrift).scan = scan;
      const init = built.init();
      init.catch(() => {});
      await enteredP;
      // The start is waiting in the extension load: the schedulers are armed already, but a tick
      // (the cron's own trigger, the decorated methods the timers call) runs nothing
      await built.get(SchedulerRegistry).getCronJob(WAIT_SWEEP_JOB).fireOnTick();
      await built.get(WaitSweepJob).run();
      await built.get(ToolJobs).scanDrift();
      expect(sweep).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(lines.some((l) => l.msg === "cron skipped: the scheduler is not started")).toBe(true);
      release();
      await init;
      // the worker role opened the gate: the runOnStart drift scan and a forced tick run
      await vi.waitFor(() => expect(scan).toHaveBeenCalled(), { timeout: 10_000 });
      await built.get(WaitSweepJob).run();
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(lines.filter((l) => l.level === "error")).toEqual([]);
    } finally {
      release?.();
      g[SLOW_GATES_KEY]?.delete(key);
    }
  }, 60_000);
});
