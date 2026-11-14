import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationTopic } from "../../src/conversations/event-log.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { createLogger } from "../../src/log.js";
import {
  COMPACTION_PROGRESS_FLUSH_MS,
  COMPACTION_PROGRESS_TTL_SECONDS,
  CompactionProgressService,
  compactionProgressKey,
} from "../../src/runtime/compaction-progress.js";

const silent = createLogger("error", { write: () => {} });

let rd: TestContainer;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let bus: ExtensionContext["bus"];
let service: CompactionProgressService;

const base = {
  runId: "run-1",
  conversationId: "conv-1",
  agentId: "agent-1",
};

const stored = async (runId = "run-1") => {
  const raw = await redis.get(compactionProgressKey(runId));
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};

beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  bus = createBus(redis, sub, "kernel", silent);
});

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await rd?.stop();
});

beforeEach(async () => {
  await redis.flushdb();
  // a fresh service: its in-process throttle map is per writer, and each case starts clean
  service = new CompactionProgressService(redis, bus, silent);
});

describe("CompactionProgressService", () => {
  it("writes the run's key with a TTL and emits one bus message on the conversation's topic", async () => {
    const seen: unknown[] = [];
    const un = await bus.subscribe(conversationTopic("conv-1"), (m) => void seen.push(m));
    try {
      service.update({
        ...base,
        progress: { phase: "preparing", step: 2, startedAt: 1000 },
      });

      expect(await stored()).toEqual({ phase: "preparing", step: 2, startedAt: 1000 });
      const ttl = await redis.ttl(compactionProgressKey("run-1"));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(COMPACTION_PROGRESS_TTL_SECONDS);

      // the fire-and-forget publish lands on the subscriber's own connection
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen).toEqual([
        {
          kind: "compaction_progress",
          runId: "run-1",
          conversationId: "conv-1",
          agentId: "agent-1",
          phase: "preparing",
          step: 2,
          startedAt: 1000,
        },
      ]);
    } finally {
      await un();
    }
  });

  it("carries chunk progress in the chunked path and only there", async () => {
    service.update({
      ...base,
      progress: { phase: "summarizing", step: 1, chunk: 2, chunks: 3, chars: 120, startedAt: 5 },
    });
    expect(await stored()).toEqual({
      phase: "summarizing",
      step: 1,
      chunk: 2,
      chunks: 3,
      chars: 120,
      startedAt: 5,
    });

    service.update({
      ...base,
      runId: "run-2",
      progress: { phase: "summarizing", step: 1, chars: 40, startedAt: 6 },
    });
    expect(await stored("run-2")).toEqual({
      phase: "summarizing",
      step: 1,
      chars: 40,
      startedAt: 6,
    });
  });

  it("writes a phase change at once but chars at most every flush window", async () => {
    const first = { phase: "summarizing" as const, step: 1, chars: 10, startedAt: 7 };
    service.update({ ...base, progress: first });
    expect(await stored()).toEqual(first);

    // inside the window the streamed chars are dropped (the key keeps the first snapshot)
    service.update({ ...base, progress: { ...first, chars: 20 } });
    service.update({ ...base, progress: { ...first, chars: 30 } });
    expect(await stored()).toEqual(first);

    // a phase change is never throttled
    service.update({ ...base, progress: { phase: "writing", step: 1, startedAt: 7 } });
    expect(await stored()).toEqual({ phase: "writing", step: 1, startedAt: 7 });

    // after the window a summarizing update writes again: keep updating until the write lands
    await vi.waitFor(
      async () => {
        service.update({ ...base, progress: { ...first, chars: 40 } });
        expect(await stored()).toEqual({ ...first, chars: 40 });
      },
      { timeout: COMPACTION_PROGRESS_FLUSH_MS * 5, interval: 10 },
    );
  });

  it("clear deletes the run's key; a later update writes again", async () => {
    service.update({ ...base, progress: { phase: "writing", step: 1, startedAt: 9 } });
    expect(await stored()).not.toBeNull();

    service.clear("run-1");
    await vi.waitFor(async () => expect(await stored()).toBeNull());

    service.update({ ...base, progress: { phase: "preparing", step: 2, startedAt: 10 } });
    expect(await stored()).toEqual({ phase: "preparing", step: 2, startedAt: 10 });
  });

  it("a Redis failure is logged, never thrown to the run", async () => {
    let warned = 0;
    const broken = new CompactionProgressService(
      {
        set: () => Promise.reject(new Error("redis down")),
        del: () => Promise.reject(new Error("redis down")),
      } as unknown as Redis,
      {
        publish: () => Promise.reject(new Error("bus down")),
      } as unknown as ExtensionContext["bus"],
      { warn: () => void warned++ },
    );
    expect(() =>
      broken.update({ ...base, progress: { phase: "preparing", step: 1, startedAt: 1 } }),
    ).not.toThrow();
    expect(() => broken.clear("run-1")).not.toThrow();
    // both rejected writes of the update and the clear logged, not thrown
    await vi.waitFor(() => expect(warned).toBe(3));
  });
});
