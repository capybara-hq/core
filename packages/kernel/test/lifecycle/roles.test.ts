import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { WorkerHost } from "@nestjs/bullmq";
import { ModulesContainer } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeKernelApp, createKernelApp } from "../../src/app.js";
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
import { WAIT_SWEEP_JOB } from "../../src/runtime/waits.js";

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

const cfg = (roles: string[]): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 3 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles,
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
    expect(processors).toHaveLength(KERNEL_QUEUES.length);
    for (const q of queues) expect(await q.getWorkersCount(), q.name).toBe(1);
    expect(routes(a)).toContain("GET /api/v1/setup");
    expect(routes(a)).toContain("POST /channels/webhook/:connectionId");
  }, 60_000);
});
