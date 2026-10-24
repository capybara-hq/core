import type { InboundEvent } from "@capybara-hq/plugin-sdk";
import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelOutbound,
  type ChannelOutboundDeps,
  inboundJobId,
} from "../../src/channels/outbound.js";
import { ApiError } from "../../src/errors.js";
import { runConfig, waitFor } from "../helpers/runs.js";

/**
 * 渠道队列优先级的行为测试（M4 遗留）：入站任务与出站投递任务共用队列 `cap-kernel-channels`，
 * worker 并发 1、积压 20 条投递时，新到的入站消息必须排在积压的投递之前（只允许排在已占着槽的第 1 条之后）。
 * 真实 Redis + BullMQ + `ChannelOutbound`；PG / 总线 / 连接服务用最小替身，以投递任务订阅总线的顺序为处理顺序。
 * 门闸：第 1 条投递卡住并发槽，直到入站任务入队后才放行，没有时序竞争。
 */

const BACKLOG = 20;
let rd: TestContainer;

beforeAll(async () => {
  rd = await startTestRedis();
}, 120_000);

afterAll(async () => {
  await rd?.stop();
});

/** 任何 select / where 链都返回同一行（入队读 last_seq，投递读投递行）。 */
function stubDb(): ChannelOutboundDeps["db"] {
  const row = { last_seq: 1, connection_id: "conn-1", target: {}, draft_message_id: null };
  const chain: unknown = new Proxy(() => {}, {
    get: (_t, p) =>
      p === "then" ? undefined : p === "executeTakeFirst" ? () => Promise.resolve(row) : chain,
    apply: () => chain,
  });
  return chain as ChannelOutboundDeps["db"];
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
    const deps = {
      db: stubDb(),
      redis,
      redisUrl: rd.url,
      // 投递任务读到投递行后订阅总线：这里记下处理顺序，第 1 条卡在门闸上占着并发槽
      bus: {
        subscribe: async (topic: string) => {
          order.push(`deliver:${topic}`);
          if (order.length === 1) await gate;
          return async () => {};
        },
      },
      eventLog: { readAfter: async () => [] },
      // 取不到出站会话：投递任务记一笔警告后直接结束，不走真实投递
      connections: {
        outbound: async () => {
          throw new ApiError("not_found", "connection not found");
        },
      },
      approvals: {},
      questions: {},
      config: () =>
        runConfig(
          { pg: "postgres://unused", redis: rd.url },
          { channels: { deliveryConcurrency: 1 } },
        ),
      log: { error: () => {}, warn: () => {}, info: () => {} },
      inbound: async () => {
        order.push("inbound");
      },
    } as unknown as ChannelOutboundDeps;
    const outbound = new ChannelOutbound(deps);
    try {
      // 先积压 20 条投递（各一个会话），worker 还没启动
      for (let i = 0; i < BACKLOG; i++) await outbound.enqueue(`conv-${i}`);
      outbound.startWorker();
      // 第 1 条投递占住唯一的并发槽，其余 19 条在队列里
      await waitFor(async () => order.length === 1 || undefined, 15_000, "first delivery started");
      const event = { type: "message", messageId: "m1" } as unknown as InboundEvent;
      await outbound.enqueueInbound("conn-1", event, inboundJobId("conn-1", "m1"));
      release();
      await waitFor(async () => order.length === BACKLOG + 1 || undefined, 20_000, "all processed");
      expect(order.indexOf("inbound")).toBe(1);
      expect(order.slice(2).every((s) => s.startsWith("deliver:"))).toBe(true);
    } finally {
      release();
      await outbound.close();
      redis.disconnect();
    }
  }, 60_000);
});
