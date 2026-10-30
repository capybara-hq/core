import { WorkerHost } from "@nestjs/bullmq";
import { Queue, type Worker } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  INFRA_RESERVE_MS,
  MIN_CLOSE_MS,
  QueueShutdown,
} from "../../src/infra/queue/queue-shutdown.js";

class Host extends WorkerHost {
  async process(): Promise<void> {}
}

const never = () => new Promise<void>(() => {});

/** A processor whose worker's close never resolves (Redis down), and one that closes. */
function fakes() {
  const stuck = { name: "stuck", close: vi.fn(never), disconnect: vi.fn(async () => {}) };
  const fine = { name: "fine", close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const hosts = [stuck, fine].map((w) => {
    const h = new Host();
    (h as unknown as { _worker: unknown })._worker = w;
    return h;
  });
  const queue = Object.create(Queue.prototype) as Queue;
  Object.defineProperty(queue, "name", { value: "q" });
  const queueClose = vi.fn(never);
  const queueDisconnect = vi.fn(async () => {});
  Object.assign(queue, { close: queueClose, disconnect: queueDisconnect });
  const providers = [...hosts, queue, { notBull: true }, undefined].map((instance) => ({
    instance,
  }));
  return { stuck, fine, queue, queueClose, queueDisconnect, providers };
}

describe("QueueShutdown", () => {
  it("a close that never resolves is abandoned within the budget, keeping the infra reserve", async () => {
    const f = fakes();
    const warn = vi.fn();
    // 2.5 s left: 0.5 s after the reserve, so the minimum (1 s) applies
    const s = new QueueShutdown(
      { getProviders: () => f.providers as never },
      { warn },
      { remainingMs: () => INFRA_RESERVE_MS + 500 },
    );
    const t0 = Date.now();
    await s.beforeApplicationShutdown();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(MIN_CLOSE_MS - 50);
    expect(took).toBeLessThan(MIN_CLOSE_MS + 500);
    // the stuck worker: disconnected, and its later close (@nestjs/bullmq's) returns at once
    expect(f.stuck.disconnect).toHaveBeenCalledTimes(1);
    await expect((f.stuck as unknown as Worker).close()).resolves.toBeUndefined();
    // the worker that closed is left alone
    expect(f.fine.close).toHaveBeenCalledTimes(1);
    expect(f.fine.disconnect).not.toHaveBeenCalled();
    // the stuck queue is disconnected (its own forceDisconnectOnShutdown follows its close)
    expect(f.queueDisconnect).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map((c) => (c[1] as { step: string }).step).sort()).toEqual([
      "queue q",
      "worker stuck",
    ]);
  });

  it("with time left, the budget is what remains less the reserve", async () => {
    const f = fakes();
    const s = new QueueShutdown(
      { getProviders: () => f.providers as never },
      { warn: () => {} },
      { remainingMs: () => INFRA_RESERVE_MS + 1_500 },
    );
    const t0 = Date.now();
    await s.beforeApplicationShutdown();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1_450);
    expect(took).toBeLessThan(2_000);
  });
});
