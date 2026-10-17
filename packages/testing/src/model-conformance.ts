import {
  type ContentBlock,
  ModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface ConformanceTarget {
  provider: ModelProvider;
  model: string;
  expect: { thinking: boolean; caching: boolean };
  teardown(): Promise<void>;
}

type Complete = Extract<ModelStreamEvent, { type: "message_complete" }>;

async function collect(
  provider: ModelProvider,
  req: ModelRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ events: ModelStreamEvent[]; done: Complete }> {
  const events: ModelStreamEvent[] = [];
  for await (const ev of provider.stream(req, { signal })) events.push(ev);
  const completes = events.filter((e) => e.type === "message_complete");
  expect(completes).toHaveLength(1);
  expect(events[events.length - 1]?.type).toBe("message_complete");
  return { events, done: completes[0] as Complete };
}

const textOf = (content: ContentBlock[]): string =>
  content.map((b) => (b.type === "text" ? b.text : "")).join("");

/** model-provider@1 一致性套件：每个供应商插件都应通过。 */
export function describeModelProviderConformance(
  name: string,
  setup: () => Promise<ConformanceTarget>,
): void {
  describe(`model-provider conformance: ${name}`, () => {
    let t: ConformanceTarget;
    beforeAll(async () => {
      t = await setup();
    });
    afterAll(async () => {
      await t?.teardown();
    });

    const base = (over: Partial<ModelRequest> = {}): ModelRequest => ({
      model: t.model,
      system: [{ text: "You are a concise assistant.", cache: true }],
      messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
      tools: [],
      maxOutputTokens: 1024,
      ...over,
    });
    const weather = {
      name: "get_weather",
      description: "Get the current weather for a city.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    };

    it("streams text", async () => {
      const { events, done } = await collect(t.provider, base());
      const deltas = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("")).toBe(textOf(done.content));
      expect(done.stopReason).toBe("end_turn");
    });

    it("tool round trip", async () => {
      const first = base({
        tools: [weather],
        messages: [
          { role: "user", content: [{ type: "text", text: "What is the weather in Paris?" }] },
        ],
      });
      const { done } = await collect(t.provider, first);
      expect(done.stopReason).toBe("tool_use");
      const call = done.content.find((b) => b.type === "tool_call");
      expect(call).toBeDefined();
      if (call?.type !== "tool_call") return;
      expect(typeof call.input).toBe("object");
      expect(call.input).not.toBeNull();
      const second = await collect(
        t.provider,
        base({
          tools: [weather],
          messages: [
            ...first.messages,
            { role: "assistant", content: done.content },
            {
              role: "user",
              content: [
                { type: "tool_result", callId: call.id, content: "Sunny, 22C", isError: false },
              ],
            },
          ],
        }),
      );
      expect(second.done.content.some((b) => b.type === "text")).toBe(true);
    });

    it("thinking replay", async (ctx) => {
      if (!t.expect.thinking) return ctx.skip();
      const first = base({
        effort: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "What is 17 * 23?" }] }],
      });
      const { done } = await collect(t.provider, first);
      expect(done.content.some((b) => b.type === "thinking")).toBe(true);
      const second = await collect(
        t.provider,
        base({
          effort: "low",
          messages: [
            ...first.messages,
            { role: "assistant", content: done.content },
            { role: "user", content: [{ type: "text", text: "Now add 1." }] },
          ],
        }),
      );
      expect(second.done.stopReason).toBe("end_turn");
    });

    it("caching", async (ctx) => {
      if (!t.expect.caching) return ctx.skip();
      const req = base({
        system: [{ text: `Stable prefix. ${"Reference material. ".repeat(600)}`, cache: true }],
      });
      await collect(t.provider, req);
      const second = await collect(t.provider, req);
      expect(second.done.usage.cacheReadTokens).toBeGreaterThan(0);
    });

    it("usage", async () => {
      const { done } = await collect(t.provider, base());
      expect(done.usage.inputTokens).toBeGreaterThan(0);
      expect(done.usage.outputTokens).toBeGreaterThan(0);
    });

    it("mid-conversation system", async () => {
      const { done } = await collect(
        t.provider,
        base({
          messages: [
            { role: "user", content: [{ type: "text", text: "Say hello." }] },
            { role: "assistant", content: [{ type: "text", text: "Hello." }] },
            { role: "system", content: "Reminder: keep answers under ten words." },
            { role: "user", content: [{ type: "text", text: "Say goodbye." }] },
          ],
        }),
      );
      expect(done.content.length).toBeGreaterThan(0);
    });

    it("abort", async () => {
      const ac = new AbortController();
      const it = t.provider.stream(base(), { signal: ac.signal })[Symbol.asyncIterator]();
      const firstEv = await it.next();
      expect(firstEv.done).toBe(false);
      ac.abort();
      let err: unknown;
      try {
        // 事件不再继续产出：中止后最多再得到已缓冲的事件，随后必须抛错而不是正常结束
        for (;;) {
          const r = await it.next();
          if (r.done) break;
          expect(r.value.type).not.toBe("message_complete");
        }
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("aborted");
    });
  });
}
