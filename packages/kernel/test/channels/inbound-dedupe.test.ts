import type { ChannelWebhookRequest, InboundEvent } from "@capybara-hq/plugin-sdk";
import { fakeDm, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ChannelInbound,
  DEDUPE_DONE,
  DEDUPE_PENDING,
  messageDedupeKey,
} from "../../src/channels/inbound.js";
import { ChannelWebhooks } from "../../src/channels/webhook.js";

/**
 * Two-state inbound dedupe: a redelivery that arrives while the first enqueue hangs is acked only
 * once the job is really queued, and a failed enqueue never loses the event. Real Redis; the queue
 * is a fake whose calls are settled by hand.
 */

const CONN = "6f1d2c3b-0a9e-4f8d-8c7b-6a5e4d3c2b1a";

let rd: TestContainer;
let redis: Redis;

/** A queue whose every `enqueueInbound` waits until the test settles it. */
function manualQueue() {
  const calls: {
    jobId: string;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  const queued = new Set<string>();
  return {
    calls,
    queued,
    enqueueInbound(_id: string, _e: InboundEvent, jobId: string) {
      return new Promise<void>((resolve, reject) => {
        calls.push({
          jobId,
          resolve: () => {
            queued.add(jobId);
            resolve();
          },
          reject,
        });
      });
    },
  };
}

const makeInbound = (queue: ReturnType<typeof manualQueue>, r: Redis = redis) =>
  new ChannelInbound({
    db: {} as never,
    redis: r,
    connections: {} as never,
    conversations: {} as never,
    external: {} as never,
    binding: {} as never,
    directorySync: {} as never,
    outbound: {} as never,
    queue,
    approvals: {} as never,
    questions: {} as never,
    log: { warn: () => {}, info: () => {} },
  });

/** Tracks whether a promise settled, without unhandled rejections. */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; ok?: boolean; value?: T } = { settled: false };
  p.then(
    (value) => Object.assign(state, { settled: true, ok: true, value }),
    () => Object.assign(state, { settled: true, ok: false }),
  );
  return state;
}

const tick = () => new Promise((r) => setTimeout(r, 30));
/** Polls until a tracked promise settled (a fixed wait races the Redis round trips after it). */
const waitSettled = async (state: { settled: boolean }) => {
  for (let i = 0; i < 100 && !state.settled; i++) await tick();
  expect(state.settled).toBe(true);
};

const waitCalls = async (q: ReturnType<typeof manualQueue>, n: number) => {
  for (let i = 0; i < 100 && q.calls.length < n; i++) await tick();
  expect(q.calls).toHaveLength(n);
};

beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await rd?.stop();
});

let n = 0;
let event: InboundEvent;
let key: string;
beforeEach(() => {
  n++;
  event = fakeDm(`dedupe-${n}`, "u-1", "hello");
  key = messageDedupeKey(CONN, `dedupe-${n}`);
});

describe("two-state inbound dedupe (long connection: onEvent)", () => {
  it("a redelivery during a hanging enqueue waits for its own enqueue; the late failure keeps done", async () => {
    const q = manualQueue();
    const inbound = makeInbound(q);
    const first = track(inbound.onEvent(CONN, event));
    await waitCalls(q, 1);
    expect(await redis.get(key)).toBe(DEDUPE_PENDING);

    const again = track(inbound.onEvent(CONN, event));
    await waitCalls(q, 2);
    // Same deterministic job id (BullMQ add is a no-op for an existing id)
    expect(q.calls[1]?.jobId).toBe(q.calls[0]?.jobId);
    await tick();
    expect(again.settled).toBe(false); // not acked before the job is queued

    q.calls[1]?.resolve();
    await waitSettled(again);
    expect(again).toMatchObject({ settled: true, ok: true });
    expect(await redis.get(key)).toBe(DEDUPE_DONE);

    q.calls[0]?.reject(new Error("redis reconnecting"));
    await waitSettled(first);
    expect(first).toMatchObject({ settled: true, ok: false });
    // Compare-and-delete: the failed first attempt does not drop `done`
    expect(await redis.get(key)).toBe(DEDUPE_DONE);
    expect(q.queued.size).toBe(1);

    // A later redelivery is acked without another enqueue
    await inbound.onEvent(CONN, event);
    expect(q.calls).toHaveLength(2);
  });

  it("both attempts fail: neither is acked, the key is cleared, the next redelivery queues it", async () => {
    const q = manualQueue();
    const inbound = makeInbound(q);
    const first = track(inbound.onEvent(CONN, event));
    await waitCalls(q, 1);
    const again = track(inbound.onEvent(CONN, event));
    await waitCalls(q, 2);
    q.calls[1]?.reject(new Error("down"));
    await waitSettled(again);
    expect(again).toMatchObject({ settled: true, ok: false });
    q.calls[0]?.reject(new Error("down"));
    await waitSettled(first);
    expect(first).toMatchObject({ settled: true, ok: false });
    expect(await redis.get(key)).toBeNull();

    const third = track(inbound.onEvent(CONN, event));
    await waitCalls(q, 3);
    q.calls[2]?.resolve();
    await waitSettled(third);
    expect(third).toMatchObject({ settled: true, ok: true });
    expect(q.queued.size).toBe(1);
    expect(await redis.get(key)).toBe(DEDUPE_DONE);
  });
});

describe("two-state inbound dedupe (key vanishes between SET NX and GET)", () => {
  /** Redis whose GET of the dedupe key first deletes it (the other attempt's compare-and-delete or TTL). */
  const vanishingRedis = () =>
    new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (k: string) => {
            await target.del(k);
            return target.get(k);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

  it("a redelivery reading null is not acked until its own enqueue succeeds", async () => {
    const q = manualQueue();
    await redis.set(key, DEDUPE_PENDING, "EX", 60);
    const inbound = makeInbound(q, vanishingRedis());
    const again = track(inbound.onEvent(CONN, event));
    await waitCalls(q, 1);
    await tick();
    expect(again.settled).toBe(false);
    q.calls[0]?.resolve();
    await waitSettled(again);
    expect(again).toMatchObject({ settled: true, ok: true });
    expect(q.queued.size).toBe(1);
    expect(await redis.get(key)).toBe(DEDUPE_DONE);
  });

  it('a legacy "1" key from the old code still acks without enqueueing', async () => {
    const q = manualQueue();
    await redis.set(key, "1", "EX", 60);
    await makeInbound(q).onEvent(CONN, event);
    expect(q.calls).toHaveLength(0);
  });
});

describe("two-state inbound dedupe (webhook path)", () => {
  const request: ChannelWebhookRequest = {
    method: "POST",
    headers: {},
    body: new Uint8Array(),
    receivedAt: 0,
  };
  const makeWebhooks = (inbound: ChannelInbound) =>
    new ChannelWebhooks({
      connections: {
        row: async () => ({
          id: CONN,
          orgId: "o1",
          plugin: "p",
          agentId: "a",
          unboundPolicy: "bind",
          status: "active",
          inboundMode: "webhook",
          tenantId: "t1",
          pluginEnabled: true,
        }),
        runtime: (async () => ({
          row: {},
          config: {},
          channel: {
            webhook: {
              handle: async () => ({
                kind: "events",
                events: [event],
                ack: { status: 200, body: "ok" },
              }),
            },
          },
        })) as never,
      },
      inbound,
      log: { warn: () => {} },
    });

  /** The same Redis with an extra delay before every command (slow network or a busy server). */
  const slowRedis = () =>
    new Proxy(redis, {
      get(t, p) {
        const v = Reflect.get(t, p);
        return typeof v === "function"
          ? async (...a: unknown[]) => {
              await new Promise((r) => setTimeout(r, 40));
              return v.apply(t, a);
            }
          : v;
      },
    });

  it.each([
    ["Redis", () => redis],
    ["a slow Redis", slowRedis],
  ])(
    "a redelivered webhook is answered 200 only after its job is queued, 503 if that fails (%s)",
    async (_name, r) => {
      const q = manualQueue();
      const webhooks = makeWebhooks(makeInbound(q, r()));
      const call = () => webhooks.handle(CONN, request, new AbortController().signal);

      const first = track(call());
      await waitCalls(q, 1);
      const again = track(call());
      await waitCalls(q, 2);
      await tick();
      expect(again.settled).toBe(false);
      q.calls[1]?.reject(new Error("down"));
      await waitSettled(again);
      expect(again.value?.status).toBe(503);

      const third = track(call());
      await waitCalls(q, 3);
      await tick();
      expect(third.settled).toBe(false);
      q.calls[2]?.resolve();
      await waitSettled(third);
      expect(third.value?.status).toBe(200);

      q.calls[0]?.reject(new Error("late failure"));
      await waitSettled(first);
      expect(first.value?.status).toBe(503);
      // The event is not lost: queued once, and the key says so
      expect(q.queued.size).toBe(1);
      expect(await redis.get(key)).toBe(DEDUPE_DONE);
    },
  );
});
