import type { ModelCacheInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { deriveCacheExpiry } from "../../../src/runtime/context/cache-expiry.js";

/** The prompt cache expiry derived from the event log (idle compaction spec §9.3). */

const T = Date.UTC(2026, 10, 28, 12, 0, 0);
const base = {
  ttlIsMinimum: false,
  refreshOnHit: true,
  ttlClock: "request_start",
  guaranteed: true,
} as const;
const anthropic: ModelCacheInfo = {
  ...base,
  mechanism: "explicit",
  ttlOptions: [300, 3600],
  defaultTtl: 300,
};
const deepseek: ModelCacheInfo = {
  mechanism: "implicit",
  ttlOptions: [],
  ttlIsMinimum: false,
  refreshOnHit: false,
  ttlClock: "unknown",
  guaranteed: false,
};
const cacheOf =
  (cache: ModelCacheInfo | undefined) =>
  (_p: string, _m: string): ModelCacheInfo | undefined =>
    cache;

let seq = 0;
function call(
  step: number,
  at: number,
  opts: { cacheTtl?: number; runId?: string } = {},
): ConversationEvent {
  seq += 1;
  return {
    conversationId: "c",
    seq,
    runId: opts.runId ?? "r1",
    createdAt: new Date(at),
    type: "model_call",
    payload: {
      step,
      attempt: 1,
      provider: "p",
      model: "m",
      fallback: false,
      request: { cacheTtl: opts.cacheTtl },
    },
  } as unknown as ConversationEvent;
}
function usage(
  step: number,
  at: number,
  tokens: { read?: number; write?: number },
  purpose?: string,
  runId = "r1",
): ConversationEvent {
  seq += 1;
  return {
    conversationId: "c",
    seq,
    runId,
    createdAt: new Date(at),
    type: "usage",
    payload: {
      step,
      provider: "p",
      model: "m",
      cacheReadTokens: tokens.read ?? 0,
      cacheWriteTokens: tokens.write ?? 0,
      purpose,
    },
  } as unknown as ConversationEvent;
}

describe("deriveCacheExpiry", () => {
  it("prefers the recorded cacheTtl over the default", () => {
    const events = [call(1, T, { cacheTtl: 3600 }), usage(1, T + 5000, { write: 100 })];
    const r = deriveCacheExpiry(events, cacheOf(anthropic));
    expect(r).toMatchObject({ ttl: 3600, t0: T, expiresAt: T + 3_600_000, isMinimum: false });
  });

  it("uses defaultTtl when no value was recorded", () => {
    const events = [call(1, T), usage(1, T + 5000, { read: 10 })];
    expect(deriveCacheExpiry(events, cacheOf(anthropic))?.ttl).toBe(300);
  });

  it("is not moved by a later call with no cache tokens", () => {
    const events = [
      call(1, T),
      usage(1, T + 1000, { write: 50 }),
      call(2, T + 60_000),
      usage(2, T + 61_000, {}),
    ];
    const r = deriveCacheExpiry(events, cacheOf(anthropic));
    expect(r?.t0).toBe(T);
  });

  it("takes the latest call with cache reads", () => {
    const events = [
      call(1, T),
      usage(1, T + 1000, { write: 50 }),
      call(2, T + 60_000),
      usage(2, T + 61_000, { read: 50 }),
    ];
    expect(deriveCacheExpiry(events, cacheOf(anthropic))?.t0).toBe(T + 60_000);
  });

  it("takes the last write, not the last read, without refreshOnHit", () => {
    const noRefresh = { ...anthropic, refreshOnHit: false };
    const events = [
      call(1, T),
      usage(1, T + 1000, { write: 50 }),
      call(2, T + 60_000),
      usage(2, T + 61_000, { read: 50 }),
    ];
    expect(deriveCacheExpiry(events, cacheOf(noRefresh))?.t0).toBe(T);
  });

  it("takes the usage time when the clock is unknown", () => {
    const unknownClock = { ...anthropic, ttlClock: "unknown" as const };
    const events = [call(1, T), usage(1, T + 7000, { write: 5 })];
    expect(deriveCacheExpiry(events, cacheOf(unknownClock))?.t0).toBe(T + 7000);
  });

  it("fires at 90% of a long lifetime and 30 s before a short expiry", () => {
    const long = deriveCacheExpiry(
      [call(1, T, { cacheTtl: 1800 }), usage(1, T + 1, { write: 5 })],
      cacheOf({ ...anthropic, ttlOptions: [300, 1800], defaultTtl: 300 }),
    );
    expect(long?.fireAt).toBe(T + 1_620_000);
    const short = deriveCacheExpiry(
      [call(1, T, { cacheTtl: 60 }), usage(1, T + 1, { write: 5 })],
      cacheOf({ ...anthropic, ttlOptions: [60], defaultTtl: 60 }),
    );
    expect(short?.expiresAt).toBe(T + 60_000);
    expect(short?.fireAt).toBe(T + 30_000);
  });

  it("follows ttlIsMinimum", () => {
    const events = [call(1, T), usage(1, T + 1, { write: 5 })];
    expect(
      deriveCacheExpiry(events, cacheOf({ ...anthropic, ttlIsMinimum: true }))?.isMinimum,
    ).toBe(true);
  });

  it("returns null for a non-guaranteed, invalid or absent declaration", () => {
    const events = [call(1, T), usage(1, T + 1, { write: 5 })];
    expect(deriveCacheExpiry(events, cacheOf(deepseek))).toBeNull();
    expect(deriveCacheExpiry(events, cacheOf(undefined))).toBeNull();
    const { defaultTtl: _omitted, ...invalid } = anthropic;
    expect(deriveCacheExpiry(events, cacheOf(invalid))).toBeNull();
  });

  it("returns null without step usage", () => {
    expect(deriveCacheExpiry([call(1, T)], cacheOf(anthropic))).toBeNull();
    expect(deriveCacheExpiry([], cacheOf(anthropic))).toBeNull();
  });

  it("ignores a compaction usage with cache reads after the last call", () => {
    const events = [
      call(1, T),
      usage(1, T + 1000, { write: 50 }),
      usage(0, T + 90_000, { read: 500 }, "compaction"),
    ];
    const r = deriveCacheExpiry(events, cacheOf(anthropic));
    expect(r?.t0).toBe(T);
    expect(r?.callSeq).toBe(events[0]?.seq);
  });
});
