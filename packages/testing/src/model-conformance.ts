import {
  assertValidDeclarations,
  type ContentBlock,
  isModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelProviderV1,
  type ModelRequest,
  type ModelRequestV1,
  type ModelStreamEvent,
  sanitizeParams,
  validateParams,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface TargetCommon {
  model: string;
  expect: { thinking: boolean; caching: boolean };
  /** caching 用例的稳定前缀大小（约 token 数），默认 5000。 */
  cachePrefixTokens?: number;
  teardown(): Promise<void>;
}

/**
 * 被测供应商：`contract` 缺省为 1（`model-provider@1`）；`@2` 插件须给 `contract: 2` 与插件名
 * （用于校验厂商专有参数的键名前缀）。
 */
export type ConformanceTarget = TargetCommon &
  (
    | { contract?: 1; provider: ModelProviderV1 }
    | { contract: 2; plugin: string; provider: ModelProvider }
  );

type Complete = Extract<ModelStreamEvent, { type: "message_complete" }>;

/** 套件内部用的请求：`params` 只对 `@2` 生效（缺省 `{}`），`@1` 时不发送。 */
type SuiteRequest = ModelRequestV1 & { params?: ModelRequest["params"] };

function streamOf(
  t: ConformanceTarget,
  req: SuiteRequest,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  const { params, ...rest } = req;
  if (t.contract === 2) return t.provider.stream({ ...rest, params: params ?? {} }, { signal });
  return t.provider.stream(rest, { signal });
}

/**
 * `@2` 参数声明检查：每个模型的 `parameters` 须通过 `assertValidDeclarations`，
 * 每个声明的默认值须通过 `validateParams`。返回问题列表（形如 `<模型 id>: <原因>`），无问题为空。
 */
export function checkDeclaredParameters(plugin: string, models: ModelInfo[]): string[] {
  const problems: string[] = [];
  for (const m of models) {
    try {
      assertValidDeclarations(plugin, m.parameters);
    } catch (e) {
      problems.push(`${m.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const d of m.parameters) {
      if (d.default === undefined) continue;
      const r = validateParams(m.parameters, { [d.key]: d.default });
      if (!r.ok) problems.push(`${m.id}: default of ${r.issues.map((i) => i.message).join("; ")}`);
    }
  }
  return problems;
}

async function collect(
  t: ConformanceTarget,
  req: SuiteRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ events: ModelStreamEvent[]; done: Complete }> {
  const events: ModelStreamEvent[] = [];
  for await (const ev of streamOf(t, req, signal)) events.push(ev);
  const completes = events.filter((e) => e.type === "message_complete");
  expect(completes).toHaveLength(1);
  expect(events[events.length - 1]?.type).toBe("message_complete");
  return { events, done: completes[0] as Complete };
}

const textOf = (content: ContentBlock[]): string =>
  content.map((b) => (b.type === "text" ? b.text : "")).join("");

/** model-provider 一致性套件（`@1` 与 `@2`）：每个供应商插件都应通过。 */
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

    const base = (over: Partial<SuiteRequest> = {}): SuiteRequest => ({
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
      const { events, done } = await collect(t, base());
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
      const { done } = await collect(t, first);
      expect(done.stopReason).toBe("tool_use");
      const call = done.content.find((b) => b.type === "tool_call");
      expect(call).toBeDefined();
      if (call?.type !== "tool_call") return;
      expect(typeof call.input).toBe("object");
      expect(call.input).not.toBeNull();
      const second = await collect(
        t,
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

    /** 思考用例的参数：`@1` 发 `effort: "low"`；`@2` 按该模型的声明取 effort low（若声明）并补默认值。 */
    const thinkingOver = async (): Promise<Partial<SuiteRequest>> => {
      if (t.contract !== 2) return { effort: "low" };
      const info = (await t.provider.listModels()).find((m) => m.id === t.model);
      return { params: sanitizeParams(info?.parameters ?? [], { effort: "low" }).value };
    };

    it("declares valid parameters", async (ctx) => {
      if (t.contract !== 2) return ctx.skip();
      expect(checkDeclaredParameters(t.plugin, await t.provider.listModels())).toEqual([]);
    });

    it("thinking replay", async (ctx) => {
      if (!t.expect.thinking) return ctx.skip();
      const over = await thinkingOver();
      const first = base({
        ...over,
        messages: [{ role: "user", content: [{ type: "text", text: "What is 17 * 23?" }] }],
      });
      const { done } = await collect(t, first);
      expect(done.content.some((b) => b.type === "thinking")).toBe(true);
      const second = await collect(
        t,
        base({
          ...over,
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
        system: [
          {
            text: `Stable prefix. ${"Reference material. ".repeat(Math.ceil((t.cachePrefixTokens ?? 5000) / 4))}`,
            cache: true,
          },
        ],
      });
      await collect(t, req);
      const second = await collect(t, req);
      expect(second.done.usage.cacheReadTokens).toBeGreaterThan(0);
    });

    it("usage", async () => {
      const { done } = await collect(t, base());
      // inputTokens 只是未缓存部分：缓存命中时可能为 0，所以看三类输入之和
      const u = done.usage;
      expect(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBeGreaterThan(0);
      expect(u.outputTokens).toBeGreaterThan(0);
    });

    it("mid-conversation system", async () => {
      const { done } = await collect(
        t,
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
      const it = streamOf(t, base(), ac.signal)[Symbol.asyncIterator]();
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
      expect(isModelError(err)).toBe(true);
      if (isModelError(err)) expect(err.kind).toBe("aborted");
    });
  });
}
