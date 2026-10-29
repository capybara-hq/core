import type { InboundEvent } from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { type Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHANNEL_QUEUE_NAME,
  type ChannelJobData,
  ChannelJobs,
  inboundJobId,
} from "../../src/channels/jobs.js";
import { ChannelOutbound, deliverBackoff } from "../../src/channels/outbound.js";
import { ApiError } from "../../src/errors.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import { runConfig, waitFor } from "../helpers/runs.js";

/**
 * 渠道队列优先级的行为测试（M4 遗留）：入站任务与出站投递任务共用队列 `cap-kernel-channels`，
 * worker 并发 1、积压 20 条投递时，新到的入站消息必须排在积压的投递之前（只允许排在已占着槽的第 1 条之后）。
 * 真实 Redis + BullMQ + `ChannelJobs` / `ChannelOutbound`（worker 同内核 `@Processor` 的配置）；PG / 总线 / 连接服务用最小替身，以投递任务订阅总线的顺序为处理顺序。
 * 门闸：第 1 条投递卡住并发槽，直到入站任务入队后才放行，没有时序竞争。
 */

const BACKLOG = 20;
const quiet = createLogger("error", { write: () => {} });
let rd: TestContainer;

beforeAll(async () => {
  rd = await startTestRedis();
}, 120_000);

afterAll(async () => {
  await rd?.stop();
});

/** 任何 select / where 链都返回同一行（入队读 last_seq，投递读投递行）。 */
function stubDb(): never {
  const row = { last_seq: 1, connection_id: "conn-1", target: {}, draft_message_id: null };
  const chain: unknown = new Proxy(() => {}, {
    get: (_t, p) =>
      p === "then" ? undefined : p === "executeTakeFirst" ? () => Promise.resolve(row) : chain,
    apply: () => chain,
  });
  return chain as never;
}

describe("渠道队列优先级（行为）", () => {
  it("并发 1、积压 20 条投递时，后到的入站消息先于第 2 条起的全部投递", async () => {
    const redis = new Redis(rd.url);
    await redis.flushdb();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const db = stubDb();
    const log = { error: () => {}, warn: () => {}, info: () => {} };
    const config = () =>
      runConfig(
        { pg: "postgres://unused", redis: rd.url },
        { channels: { deliveryConcurrency: 1 } },
      );
    const conns: Redis[] = [];
    const conn = () => {
      const c = new Redis(rd.url, { maxRetriesPerRequest: null });
      conns.push(c);
      return c;
    };
    const queue = new Queue<ChannelJobData>(CHANNEL_QUEUE_NAME, { connection: conn() });
    const jobs = new ChannelJobs(db, queue, { on: () => () => {} }, log);
    const outbound = new ChannelOutbound(
      db,
      // 投递任务读到投递行后订阅总线：这里记下处理顺序，第 1 条卡在门闸上占着并发槽
      {
        subscribe: async (topic: string) => {
          order.push(`deliver:${topic}`);
          if (order.length === 1) await gate;
          return async () => {};
        },
      } as never,
      { readAfter: async () => [] },
      new ConversationLock(new LockService(redis, quiet)),
      // 取不到出站会话：投递任务记一笔警告后直接结束，不走真实投递
      {
        outbound: async () => {
          throw new ApiError("not_found", "connection not found");
        },
      },
      {} as never,
      {} as never,
      {
        handle: async () => {
          order.push("inbound");
        },
      },
      jobs,
      { get: config },
      log,
      {} as never,
    );
    // the worker as the kernel's `@Processor` builds it (worker role)
    const { jobLockMs, stalledIntervalMs } = config().runtime;
    const worker = new Worker<ChannelJobData>(
      CHANNEL_QUEUE_NAME,
      (job: Job<ChannelJobData>, token?: string) => outbound.process(job, token),
      {
        connection: conn(),
        concurrency: config().channels.deliveryConcurrency,
        lockDuration: jobLockMs,
        stalledInterval: stalledIntervalMs,
        maxStalledCount: 3,
        settings: { backoffStrategy: (n, _type, err) => deliverBackoff(n, err) },
        autorun: false,
      },
    );
    try {
      // 先积压 20 条投递（各一个会话），worker 还没启动
      for (let i = 0; i < BACKLOG; i++) await jobs.enqueue(`conv-${i}`);
      outbound.startWorker(worker);
      // 第 1 条投递占住唯一的并发槽，其余 19 条在队列里
      await waitFor(async () => order.length === 1 || undefined, 15_000, "first delivery started");
      const event = { type: "message", messageId: "m1" } as unknown as InboundEvent;
      await jobs.enqueueInbound("conn-1", event, inboundJobId("conn-1", "m1"));
      release();
      await waitFor(async () => order.length === BACKLOG + 1 || undefined, 20_000, "all processed");
      expect(order.indexOf("inbound")).toBe(1);
      expect(order.slice(2).every((s) => s.startsWith("deliver:"))).toBe(true);
    } finally {
      release();
      await outbound.close();
      await queue.close();
      for (const c of conns) await c.quit().catch(() => c.disconnect());
      redis.disconnect();
    }
  }, 60_000);
});
