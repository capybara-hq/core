import { describe, expect, it } from "vitest";
import { BackgroundTaskPollJob } from "../../src/background/poll.job.js";
import type { BackgroundTaskRow } from "../../src/background/store.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import type { KernelLogger } from "../../src/log.js";

/**
 * The poll skips an instance group whose device's provider is not there (environments spec
 * §6): a local device is polled with no cloud provider, a cloud one (or a task with no
 * device) waits until a cloud provider is back.
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
    sid: "123",
    sandboxCreatedAt: new Date(0),
    conversationId: `c-${id}`,
  }) as unknown as BackgroundTaskRow;

describe("background poll per device provider", () => {
  it("a device-only poll group with no cloud provider is polled; cloud and device-less groups are skipped", async () => {
    const polled: string[] = [];
    const finisherCalls: string[] = [];
    const job = new BackgroundTaskPollJob(
      {
        failAbandonedLaunches: async () => [],
        pruneFinished: async () => 0,
        runningStarted: async () => [
          task("t1", "env-device"),
          task("t2", "env-cloud"),
          task("t3", null),
        ],
      } as never,
      new Proxy({}, { get: (_t, k) => async () => void finisherCalls.push(String(k)) }) as never,
      { publishChanged: async () => {} },
      {
        cloudAvailable: false,
        availableFor: async (env: string) => env === "env-device",
        ifRunning: async (env: string) => {
          polled.push(env);
          throw new Error("stop after recording");
        },
      } as never,
      { get: () => config } as unknown as KernelConfigService,
      {} as LockService,
      { info() {}, warn() {}, debug() {}, error() {} } as unknown as KernelLogger,
    );
    expect(await job.pollOnce()).toBe(0);
    expect(polled).toEqual(["env-device"]);
    // the device-less task would be marked gone by the finisher if its group were polled
    expect(finisherCalls).toEqual([]);
  });
});
