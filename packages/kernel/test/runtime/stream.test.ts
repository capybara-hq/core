import { describe, expect, it, vi } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import {
  ConversationStreams,
  type ConversationStreamsDeps,
  type SseOutput,
  type StreamBus,
} from "../../src/runtime/stream.js";

const config = KernelConfigSchema.parse({
  db: { url: "postgres://x" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  runtime: { sseHeartbeatMs: 60_000, sseRecheckMs: 60_000 },
});

function output(backlog = () => 0) {
  const out = {
    chunks: [] as string[],
    write: vi.fn((c: string) => {
      out.chunks.push(c);
    }),
    backlog: vi.fn(backlog),
    end: vi.fn(),
    abort: vi.fn(),
  };
  return out satisfies SseOutput;
}

function busWith(subscribe: StreamBus["subscribe"]): StreamBus {
  return { subscribe };
}

const params = {
  orgId: "o",
  conversationId: "c",
  viewerAccountId: "a",
  afterSeq: 0,
  credential: async () => null,
};

/** The provider over test doubles (its constructor takes the injected dependencies). */
const streamsWith = (
  d: Omit<ConversationStreamsDeps, "config" | "eventLog" | "drafts"> & {
    eventLog: ConversationStreamsDeps["eventLog"];
    config: () => typeof config;
    drafts?: ConversationStreamsDeps["drafts"];
  },
) =>
  new ConversationStreams(d.eventLog, d.bus, { isAccessible: d.access }, { get: d.config }, d.log, {
    live: d.drafts ?? (async () => []),
  });

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("ConversationStreams", () => {
  it("订阅失败：抛出原错误，且不碰输出端（由 HTTP 层按普通错误返回）", async () => {
    const out = output();
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async () => {
        throw new Error("redis down");
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    await expect(streams.open(params, out)).rejects.toThrow("redis down");
    expect(out.end).not.toHaveBeenCalled();
    expect(out.abort).not.toHaveBeenCalled();
    expect(out.write).not.toHaveBeenCalled();
    expect(streams.size).toBe(0);
  });

  it("不可见：conversation.not_found，不订阅", async () => {
    const subscribe = vi.fn(async () => async () => {});
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(subscribe),
      access: async () => false,
      config: () => config,
      log: { warn: () => {} },
    });
    const err = await streams.open(params, output()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("conversation.not_found");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("慢客户端积压超限：销毁连接（abort）而不是 end，并退订", async () => {
    let handler: ((m: unknown) => unknown) | undefined;
    const unsubscribe = vi.fn(async () => {});
    let pending = 0;
    const out = output(() => pending);
    out.write.mockImplementation((c: string) => {
      pending += c.length;
    });
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async (_t, h) => {
        handler = h;
        return unsubscribe;
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    const h = await streams.open(params, out);
    h.begin();
    const big = "x".repeat(1024 * 1024);
    for (let i = 0; i < 6; i++) {
      handler?.({ kind: "delta", runId: "r", step: 1, delta: "text", text: big });
    }
    await flush();
    expect(out.abort).toHaveBeenCalledTimes(1);
    expect(out.end).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
    expect(streams.size).toBe(0);
  });

  it("内部故障（补读失败）：销毁连接", async () => {
    const out = output();
    const streams = streamsWith({
      eventLog: {
        readAfter: async () => {
          throw new Error("pg down");
        },
      },
      bus: busWith(async () => async () => {}),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    const h = await streams.open(params, out);
    h.begin();
    await flush();
    expect(out.abort).toHaveBeenCalledTimes(1);
    expect(out.end).not.toHaveBeenCalled();
  });

  it("停机 closeAll：正常 end", async () => {
    const out = output();
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async () => async () => {}),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    const h = await streams.open(params, out);
    h.begin();
    streams.closeAll();
    expect(out.end).toHaveBeenCalledTimes(1);
    expect(out.abort).not.toHaveBeenCalled();
  });

  it("after closeAll a new stream ends right after its headers and never subscribes", async () => {
    const subscribe = vi.fn(async () => async () => {});
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(subscribe),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    streams.closeAll();
    const out = output();
    const h = await streams.open(params, out);
    expect(out.end).not.toHaveBeenCalled();
    h.begin();
    expect(out.end).toHaveBeenCalledTimes(1);
    expect(out.write).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(streams.size).toBe(0);
  });

  it("closeAll while a stream subscribes: the stream still ends once it begins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const unsubscribe = vi.fn(async () => {});
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async () => {
        await gate;
        return unsubscribe;
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    const out = output();
    const opening = streams.open(params, out);
    await flush();
    streams.closeAll();
    release();
    const h = await opening;
    h.begin();
    expect(out.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(streams.size).toBe(0);
  });

  it("after the catch-up, one `event: draft` per live draft, before any delta", async () => {
    let handler: ((m: unknown) => unknown) | undefined;
    const ev = {
      conversationId: "c",
      seq: 3,
      type: "model_call",
      runId: "r",
      payload: {},
      createdAt: new Date(0),
    } as unknown as ConversationEvent;
    let readAt: number | undefined;
    const calls: string[] = [];
    const out = output();
    out.write.mockImplementation((c: string) => {
      out.chunks.push(c);
    });
    const streams = streamsWith({
      eventLog: {
        readAfter: async (_c: string, after: number) => {
          calls.push(`readAfter ${after}`);
          return after < 3 ? [ev] : [];
        },
      },
      bus: busWith(async (_t, h) => {
        handler = h;
        return async () => {};
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
      drafts: async (conversationId: string) => {
        readAt = calls.length;
        calls.push(`drafts ${conversationId}`);
        return [{ runId: "r", step: 1, text: "Hel", thinking: "hm" }];
      },
    });
    const h = await streams.open(params, out);
    // a delta that arrives before the stream begins is forwarded after the draft
    handler?.({ kind: "delta", runId: "r", step: 1, delta: "text", text: "lo", offset: 3 });
    h.begin();
    await flush();
    expect(readAt).toBe(1);
    expect(out.chunks).toEqual([
      `id: 3\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`,
      `event: draft\ndata: ${JSON.stringify({ runId: "r", step: 1, text: "Hel", thinking: "hm" })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ runId: "r", step: 1, delta: "text", text: "lo", offset: 3 })}\n\n`,
    ]);
    h.close();
  });

  it("reads the drafts once, on open: a later events notice sends no draft", async () => {
    let handler: ((m: unknown) => unknown) | undefined;
    const drafts = vi.fn(async () => []);
    const out = output();
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async (_t, h) => {
        handler = h;
        return async () => {};
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
      drafts,
    });
    const h = await streams.open(params, out);
    h.begin();
    await flush();
    handler?.({ kind: "events", toSeq: 9 });
    await flush();
    expect(drafts).toHaveBeenCalledTimes(1);
    expect(out.chunks.some((c) => c.startsWith("event: draft"))).toBe(false);
    h.close();
  });

  it("a failed draft read is logged and the stream goes on", async () => {
    const warn = vi.fn();
    const out = output();
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async () => async () => {}),
      access: async () => true,
      config: () => config,
      log: { warn },
      drafts: async () => {
        throw new Error("redis down");
      },
    });
    const h = await streams.open(params, out);
    h.begin();
    await flush();
    expect(warn).toHaveBeenCalledWith(
      "conversation stream cannot read live drafts",
      expect.objectContaining({ conversationId: "c" }),
    );
    expect(out.abort).not.toHaveBeenCalled();
    expect(streams.size).toBe(1);
    h.close();
  });

  it("a compaction progress bus message is forwarded as `event: compaction`", async () => {
    let handler: ((m: unknown) => unknown) | undefined;
    const out = output();
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async (_t, h) => {
        handler = h;
        return async () => {};
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    const h = await streams.open(params, out);
    h.begin();
    await flush();
    handler?.({
      kind: "compaction_progress",
      runId: "r",
      conversationId: "c",
      agentId: "a",
      phase: "summarizing",
      step: 1,
      chunk: 2,
      chunks: 3,
      chars: 120,
      startedAt: 5,
    });
    await flush();
    expect(out.chunks).toEqual([
      `event: compaction\ndata: ${JSON.stringify({
        runId: "r",
        conversationId: "c",
        agentId: "a",
        phase: "summarizing",
        step: 1,
        chunk: 2,
        chunks: 3,
        chars: 120,
        startedAt: 5,
      })}\n\n`,
    ]);
    h.close();
  });

  it("drops a malformed compaction progress message", async () => {
    let handler: ((m: unknown) => unknown) | undefined;
    const out = output();
    const streams = streamsWith({
      eventLog: { readAfter: async () => [] },
      bus: busWith(async (_t, h) => {
        handler = h;
        return async () => {};
      }),
      access: async () => true,
      config: () => config,
      log: { warn: () => {} },
    });
    const h = await streams.open(params, out);
    h.begin();
    await flush();
    handler?.({ kind: "compaction_progress", runId: "r", conversationId: "c" });
    await flush();
    expect(out.chunks).toEqual([]);
    h.close();
  });
});
