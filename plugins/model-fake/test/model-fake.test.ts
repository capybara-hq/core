import {
  isModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createFakeProvider, type Kv, type Sleep } from "../src/script.js";

function memKv(): Kv & { store: Map<string, string>; ttls: number[] } {
  const store = new Map<string, string>();
  const ttls: number[] = [];
  return {
    store,
    ttls,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v, o) => {
      ttls.push(o.ttlSeconds);
      store.set(k, v);
    },
  };
}

const req = (text: string, over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "fake-1",
  system: [{ text: "sys", cache: true }],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
  maxOutputTokens: 1024,
  ...over,
});

async function run(
  p: ModelProvider,
  r: ModelRequest,
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of p.stream(r, { signal })) out.push(ev);
  return out;
}
const complete = (evs: ModelStreamEvent[]) => {
  const c = evs.at(-1);
  if (c?.type !== "message_complete") throw new Error("no complete");
  return c;
};
const noSleep: Sleep = async () => {};
const mk = (sleep: Sleep = noSleep) => createFakeProvider({ kv: memKv(), sleep });

describe("model-fake", () => {
  it("lists the default model", async () => {
    const [m] = await mk().listModels();
    expect(m).toMatchObject({ id: "fake-1", contextWindow: 32000 });
    expect(m?.capabilities).toMatchObject({
      tools: false,
      vision: false,
      reasoning: false,
      caching: true,
    });
  });

  it("echo streams 4-char chunks", async () => {
    const evs = await run(mk(), req("echo:abcdefghij"));
    const deltas = evs.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
    expect(deltas).toEqual(["abcd", "efgh", "ij"]);
    expect(complete(evs).content).toEqual([{ type: "text", text: "abcdefghij" }]);
    expect(complete(evs).stopReason).toBe("end_turn");
  });

  it("default reply", async () => {
    const evs = await run(mk(), req("hi"));
    expect(complete(evs).content).toEqual([{ type: "text", text: "You said: hi" }]);
  });

  it("slow waits <ms> between chunks", async () => {
    const waits: number[] = [];
    const evs = await run(
      mk(async (ms) => {
        waits.push(ms);
      }),
      req("slow:250:abcdefgh"),
    );
    expect(waits).toEqual([250]);
    expect(complete(evs).content).toEqual([{ type: "text", text: "abcdefgh" }]);
  });

  it("stall emits nothing until abort", async () => {
    const ac = new AbortController();
    const p = run(mk(), req("stall"), ac.signal);
    queueMicrotask(() => ac.abort());
    const err = await p.catch((e: unknown) => e);
    expect(isModelError(err) && err.kind).toBe("aborted");
  });

  it("fail:<kind> throws ModelError", async () => {
    const err = await run(mk(), req("fail:rate_limited")).catch((e: unknown) => e);
    expect(isModelError(err)).toBe(true);
    if (isModelError(err)) {
      expect(err.kind).toBe("rate_limited");
      expect(err.retryable).toBe(true);
    }
    const e2 = await run(mk(), req("fail:auth")).catch((e: unknown) => e);
    expect(isModelError(e2) && e2.retryable).toBe(false);
  });

  it("tool emits a tool_call", async () => {
    const evs = await run(mk(), req('tool:get_weather:{"city":"Paris"}'));
    const c = complete(evs);
    expect(c.stopReason).toBe("tool_use");
    expect(c.content[0]).toMatchObject({
      type: "tool_call",
      name: "get_weather",
      input: { city: "Paris" },
    });
  });

  it("long:<n> outputs n words", async () => {
    const c = complete(await run(mk(), req("long:50")));
    const text = c.content[0]?.type === "text" ? c.content[0].text : "";
    expect(text.split(" ")).toHaveLength(50);
  });

  it("usage is ceil(chars/4); second same prefix reports cacheRead via kv with TTL 300", async () => {
    const kv = memKv();
    const p = createFakeProvider({ kv, sleep: noSleep });
    const r = req("echo:abcde", { system: [{ text: "x".repeat(40), cache: true }] });
    const u1 = complete(await run(p, r)).usage;
    expect(u1.inputTokens).toBe(Math.ceil((40 + 10) / 4));
    expect(u1.outputTokens).toBe(2);
    expect(u1.cacheReadTokens).toBe(0);
    const u2 = complete(await run(p, r)).usage;
    expect(u2.cacheReadTokens).toBe(10);
    expect(kv.ttls).toEqual([300]);
  });

  it("supports mid-conversation system messages", async () => {
    const c = complete(
      await run(
        mk(),
        req("x", {
          messages: [
            { role: "user", content: [{ type: "text", text: "a" }] },
            { role: "system", content: "Reminder" },
            { role: "user", content: [{ type: "text", text: "echo:ok" }] },
          ],
        }),
      ),
    );
    expect(c.content).toEqual([{ type: "text", text: "ok" }]);
    expect((await mk().listModels())[0]?.capabilities.midConversationSystem).toBe(true);
  });

  it("compaction request replies with Summary of first 200 chars", async () => {
    const long = "y".repeat(300);
    const c = complete(
      await run(
        mk(),
        req(long, { system: [{ text: "CAPYBARA_COMPACTION\nSummarize.", cache: false }] }),
      ),
    );
    expect(c.content).toEqual([{ type: "text", text: `Summary: ${"y".repeat(200)}` }]);
  });

  it("unknown model is invalid_request", async () => {
    const err = await run(mk(), req("hi", { model: "nope" })).catch((e: unknown) => e);
    expect(isModelError(err) && err.kind).toBe("invalid_request");
  });
});
