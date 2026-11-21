import { describe, expect, it } from "vitest";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import type { BackgroundTaskRow } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import type { KernelLogger } from "../../src/log.js";

/**
 * The poll skips an instance group whose device's provider does not serve its org now
 * (`SandboxService.availableFor`): its tasks wait until it does. A legacy task with no device
 * needs no provider: it is finished as gone.
 */

const config = KernelConfigSchema.parse({
  db: { url: "postgres://unused/x" },
  redis: { url: "redis://unused" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});

const task = (id: string, deviceId: string | null): BackgroundTaskRow =>
  ({
    id,
    deviceId,
    orgId: "org-1",
    sid: "123",
    sandboxCreatedAt: new Date(0),
    conversationId: `c-${id}`,
  }) as unknown as BackgroundTaskRow;

describe("background poll per device provider", () => {
  it("only a group whose device's provider serves its org is polled; a device-less task finishes gone", async () => {
    const polled: string[] = [];
    const asked: string[] = [];
    const finished: { id: string; status: string }[] = [];
    const job = new BackgroundTaskPollJob(
      {
        failAbandonedLaunches: async () => [],
        pruneFinished: async () => 0,
        runningManaged: async () => [],
        owedCancels: async () => [],
        runningLegacy: async () => [
          task("t1", "env-device"),
          task("t2", "env-cloud"),
          task("t3", null),
        ],
      } as never,
      {
        finish: async (t: BackgroundTaskRow, to: { status: string }) => {
          finished.push({ id: t.id, status: to.status });
          return true;
        },
      } as never,
      { publishChanged: async () => {} },
      {
        availableFor: async (env: string, orgId: string) => {
          asked.push(`${env}@${orgId}`);
          return env === "env-device";
        },
        ifRunning: async (env: string) => {
          polled.push(env);
          throw new Error("stop after recording");
        },
      } as never,
      { get: () => config } as unknown as KernelConfigService,
      {} as LockService,
      { info() {}, warn() {}, debug() {}, error() {} } as unknown as KernelLogger,
      { stop: async () => Promise.reject(new Error("no managed task here")) } as never,
    );
    expect(await job.pollOnce()).toBe(1);
    expect(polled).toEqual(["env-device"]);
    // each device is judged in its own task's org; the device-less one asks no provider
    expect(asked).toEqual(["env-device@org-1", "env-cloud@org-1"]);
    expect(finished).toEqual([{ id: "t3", status: "lost" }]);
  });
});
