import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import {
  OUTBOX_RELAY_BATCH,
  OUTBOX_RELAY_MAX_ROUNDS,
  OUTBOX_RELAY_PERIOD_MS,
  OutboxRelay,
} from "../../src/infra/outbox/outbox.relay.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import type { OutboxJobName } from "../../src/infra/outbox/registry.js";
import { LockedIntervalScheduler } from "../../src/infra/schedule/locked-interval.js";
import { createLogger } from "../../src/log.js";
import { runConfig, sleep, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * Transactional outbox spec §3.3: the relay (`outbox-relay`, a `@LockedInterval` on the worker
 * role) delivers the rows a fast path left behind. Two kernels share PG and Redis, as two replicas
 * do: A runs only `api` and its queue adds fail (the `OUTBOX_DISPATCH_FAILS` seam, a Redis outage
 * seen by that process only); B runs only `worker`. In-process kernels, because seams cannot cross
 * the dual-replica harness's process boundary (R22: the seam tokens are not exported).
 */

const TEST_JOB = "outbox-relay-test-job" as OutboxJobName;
const QUEUE = "cap-kernel-maintenance" as const;

describe("outbox relay (two kernels, shared PG and Redis)", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let redis: Redis;
  let queue: Queue;
  let a: TestKernel;
  let b: TestKernel;

  beforeAll(async () => {
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    redis = new Redis(rdc.url, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE, { connection: redis });
    const urls = { pg: pgc.url, redis: rdc.url };
    a = await startKernel(runConfig(urls, { roles: ["api"], extensions: [] }), {
      overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: () => true }],
    });
    b = await startKernel(runConfig(urls, { roles: ["worker"], extensions: [] }));
  }, 180_000);

  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
    await queue?.close();
    await redis?.quit();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
  });

  it("a row the fast path failed is delivered by the other replica's relay within one tick", async () => {
    expect(b.app.get(LockedIntervalScheduler).periodOf("outbox-relay")).toBe(
      OUTBOX_RELAY_PERIOD_MS,
    );

    // commit just after one of B's ticks (epoch-aligned), so A's fast path claims the row before
    // B's next tick could; its failure then defers the row 1 s, still due at that next tick
    while (
      Date.now() % OUTBOX_RELAY_PERIOD_MS >= 500 ||
      Date.now() % OUTBOX_RELAY_PERIOD_MS < 100
    ) {
      await sleep(10);
    }
    const fastPath = vi.spyOn(a.app.get(OutboxDispatcher), "dispatchOwn");
    await a.app
      .get(TransactionHost)
      .run(() =>
        a.app.get(OutboxService).add({ queue: QUEUE, name: TEST_JOB, jobId: "relay-1", data: {} }),
      );
    // A's fast path ran and failed: the row stays for the relay, with the attempt recorded
    expect(fastPath).toHaveBeenCalledTimes(1);
    await fastPath.mock.results[0]?.value;
    const row = await a.app
      .get(KernelDb)
      .selectFrom("outbox")
      .select(["attempts", "last_error"])
      .where("job_id", "=", "relay-1")
      .executeTakeFirst();
    expect(row).toMatchObject({ attempts: 1, last_error: expect.stringContaining("test seam") });
    expect(await queue.getJob("relay-1")).toBeUndefined();

    await waitFor(() => queue.getJob("relay-1"), 5000, "the relayed job");
  }, 30_000);
});

describe("outbox relay tick", () => {
  /** A relay over a dispatcher that returns the given results in turn (then empty passes). */
  const relayOver = (results: { sent: number; failed: number; dead: number }[]) => {
    const dispatchDue = vi.fn(async () => results.shift() ?? { sent: 0, failed: 0, dead: 0 });
    const relay = new OutboxRelay(
      { dispatchDue },
      {} as KernelConfigService,
      {} as LockService,
      createLogger("error", { write: () => {} }),
    );
    return { relay, dispatchDue };
  };
  const full = { sent: OUTBOX_RELAY_BATCH, failed: 0, dead: 0 };

  it("runs passes of 500 until one handles fewer, counting failed rows (dead ones once)", async () => {
    const { relay, dispatchDue } = relayOver([
      full,
      { sent: 300, failed: 200, dead: 0 },
      { sent: 100, failed: 400, dead: 5 },
      { sent: 499, failed: 0, dead: 0 },
    ]);
    expect(await relay.relayOnce()).toBe(500 + 300 + 100 + 499);
    expect(dispatchDue).toHaveBeenCalledTimes(4);
    expect(dispatchDue).toHaveBeenCalledWith(OUTBOX_RELAY_BATCH);
  });

  it("stops after a pass that delivered nothing and failed rows (Redis trouble)", async () => {
    const { relay, dispatchDue } = relayOver([
      full,
      { sent: 0, failed: OUTBOX_RELAY_BATCH, dead: 0 },
      full,
    ]);
    expect(await relay.relayOnce()).toBe(OUTBOX_RELAY_BATCH);
    expect(dispatchDue).toHaveBeenCalledTimes(2);
  });

  it("stops after 10 passes, and at once when aborted", async () => {
    const busy = relayOver(Array.from({ length: 20 }, () => ({ ...full })));
    await busy.relay.relayOnce();
    expect(busy.dispatchDue).toHaveBeenCalledTimes(OUTBOX_RELAY_MAX_ROUNDS);

    const aborted = relayOver([full, full]);
    await aborted.relay.relayOnce(AbortSignal.abort());
    expect(aborted.dispatchDue).not.toHaveBeenCalled();
  });
});
