import {
  type ContentBlock,
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelProviderV1,
  type ModelRequestV1,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { checkDeclaredParameters, describeModelProviderConformance } from "../src/index.js";

const usage = (cacheRead: number) => ({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
});

/** 内存中的最小供应商：仅用于证明一致性套件可运行。 */
function makeProvider(
  mkAbort: () => Error = () => new ModelError("aborted", "aborted"),
  parameters: ModelParameter[] = [],
): ModelProvider & ModelProviderV1 {
  const seen = new Set<string>();
  return {
    async listModels() {
      return [
        {
          id: "m",
          displayName: "m",
          contextWindow: 8000,
          maxOutputTokens: 1000,
          capabilities: {
            tools: true,
            vision: false,
            reasoning: true,
            caching: true,
            midConversationSystem: true,
            effort: false,
          },
          parameters,
        },
      ];
    },
    async *stream(
      req: ModelRequestV1,
      opts: { signal: AbortSignal },
    ): AsyncGenerator<ModelStreamEvent> {
      const aborted = mkAbort;
      if (opts.signal.aborted) throw aborted();
      const last = req.messages[req.messages.length - 1];
      const lastText =
        last && last.role === "user" ? last.content.find((b) => b.type === "text") : undefined;
      const question = lastText?.type === "text" ? lastText.text : "";
      const hasResult = last?.role === "user" && last.content.some((b) => b.type === "tool_result");

      if (req.tools.length > 0 && !hasResult) {
        const content: ContentBlock[] = [
          { type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Paris" } },
        ];
        yield { type: "message_complete", content, stopReason: "tool_use", usage: usage(0) };
        return;
      }
      const content: ContentBlock[] = [];
      if (question.includes("17 * 23")) content.push({ type: "thinking", text: "17*23=391" });
      const key = JSON.stringify(req.system);
      const cacheRead = seen.has(key) ? 5 : 0;
      seen.add(key);
      yield { type: "text_delta", text: "Hel" };
      await new Promise((r) => setTimeout(r, 20));
      if (opts.signal.aborted) throw aborted();
      yield { type: "text_delta", text: "lo" };
      await new Promise((r) => setTimeout(r, 20));
      if (opts.signal.aborted) throw aborted();
      content.push({ type: "text", text: "Hello" });
      yield { type: "message_complete", content, stopReason: "end_turn", usage: usage(cacheRead) };
    },
  };
}

describeModelProviderConformance("in-memory", async () => ({
  provider: makeProvider(),
  model: "m",
  expect: { thinking: true, caching: true },
  async teardown() {},
}));

/** 模拟插件自带另一份 plugin-sdk：错误类不同但形状一致。 */
class ForeignModelError extends Error {
  readonly kind = "aborted";
}

describeModelProviderConformance("in-memory (duplicate sdk copy)", async () => ({
  provider: makeProvider(() => new ForeignModelError("aborted")),
  model: "m",
  expect: { thinking: false, caching: false },
  async teardown() {},
}));

const PARAMS: ModelParameter[] = [
  {
    key: "effort",
    standard: "effort",
    schema: { type: "string", enum: ["low", "high"] },
    default: "high",
    label: { zh: "思考深度", en: "Effort" },
  },
  {
    key: "in-memory.style",
    schema: { type: "string", enum: ["plain", "shout"] },
    default: "plain",
    label: { zh: "风格", en: "Style" },
  },
];

describeModelProviderConformance("in-memory @2", async () => ({
  contract: 2,
  plugin: "in-memory",
  provider: makeProvider(undefined, PARAMS),
  model: "m",
  expect: { thinking: true, caching: true },
  async teardown() {},
}));

describe("checkDeclaredParameters", () => {
  const model = (parameters: ModelParameter[]): ModelInfo => ({
    id: "x",
    displayName: "x",
    contextWindow: 1,
    maxOutputTokens: 1,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: false,
      caching: false,
      midConversationSystem: false,
    },
    parameters,
  });
  it("valid declarations → no problems", () => {
    expect(checkDeclaredParameters("in-memory", [model(PARAMS), model([])])).toEqual([]);
  });
  it("key without the plugin prefix is reported with the model id", () => {
    const problems = checkDeclaredParameters("in-memory", [
      model([{ key: "style", schema: { type: "boolean" }, label: { zh: "风格", en: "Style" } }]),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^x: .*"style"/);
  });
  it("default that fails validateParams is reported", () => {
    const problems = checkDeclaredParameters("in-memory", [
      model([
        {
          key: "in-memory.n",
          schema: { type: "integer", minimum: 1 },
          default: 0,
          label: { zh: "数量", en: "Count" },
        },
      ]),
    ]);
    expect(problems.join("\n")).toMatch(/in-memory\.n/);
  });
});
