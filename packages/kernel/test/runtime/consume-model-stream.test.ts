import { isModelError, type ModelRequest, type ModelStreamEvent } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeModelStream, deltaChars } from "../../src/runtime/model-call.js";
import type { BoundProvider } from "../../src/runtime/providers.js";

const IDLE_MS = 1_000;
const GAP_MS = IDLE_MS * 0.6;
const request = {} as ModelRequest;
const complete: ModelStreamEvent = {
  type: "message_complete",
  content: [{ type: "text", text: "done" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A provider that yields `events` with `GAP_MS` before each, then stalls forever when `stall`. */
function paced(events: ModelStreamEvent[], stall = false): BoundProvider {
  return {
    async *stream() {
      for (const ev of events) {
        await sleep(GAP_MS);
        yield ev;
      }
      if (stall) await new Promise<never>(() => {});
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("consumeModelStream", () => {
  it("tool deltas keep the watchdog armed", async () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "c1", name: "Write" },
      ...Array.from(
        { length: 5 },
        (_, i): ModelStreamEvent => ({
          type: "tool_call_delta",
          id: "c1",
          input: `{"p${i}":1`,
        }),
      ),
      complete,
    ];
    const seen: string[] = [];
    const out = consumeModelStream(
      paced(events),
      request,
      IDLE_MS,
      new AbortController().signal,
      (ev) => seen.push(ev.type),
    );
    // 7 gaps of 0.6 × idle: far past one idle window in total, never one idle window apart
    await vi.advanceTimersByTimeAsync(GAP_MS * events.length);
    await expect(out).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(seen).toHaveLength(6);
    expect(seen[0]).toBe("tool_call_start");
  });

  it("still times out when tool deltas stop", async () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "c1", name: "Write" },
      { type: "tool_call_delta", id: "c1", input: '{"path"' },
      { type: "tool_call_delta", id: "c1", input: ':"a.txt"' },
    ];
    const out = consumeModelStream(
      paced(events, true),
      request,
      IDLE_MS,
      new AbortController().signal,
      () => {},
    );
    const settled = out.then(
      () => undefined,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(GAP_MS * events.length + IDLE_MS);
    const err = await settled;
    expect(isModelError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe("timeout");
  });
});

describe("deltaChars", () => {
  it("counts text, thinking and tool input; a tool start carries none", () => {
    expect(deltaChars({ type: "text_delta", text: "abc" })).toBe(3);
    expect(deltaChars({ type: "thinking_delta", text: "hm" })).toBe(2);
    expect(deltaChars({ type: "tool_call_delta", id: "c1", input: '{"a":1}' })).toBe(7);
    expect(deltaChars({ type: "tool_call_start", id: "c1", name: "Write" })).toBe(0);
  });
});
