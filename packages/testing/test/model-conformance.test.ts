import {
  type ContentBlock,
  type EmbedRequest,
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  validateMediaBlock,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  checkDeclaredParameters,
  checkToolStream,
  describeModelProviderConformance,
  isPngBase64,
  MEDIA_SAMPLES,
  pdfBase64,
  pdfSampleWord,
  redPngBase64,
  thinkingReplayParams,
} from "../src/index.js";

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
): ModelProvider {
  const seen = new Set<string>();
  return {
    async embed(req: EmbedRequest) {
      return {
        vectors: req.input.map(() => Array.from({ length: req.dimensions ?? 8 }, () => 0.25)),
        usage: { inputTokens: req.input.length },
      };
    },
    async listModels() {
      return [
        {
          id: "e",
          displayName: "e",
          kind: "embedding" as const,
          embedding: { dimensions: [8], defaultDimensions: 8, maxInputTokens: 512, maxBatch: 16 },
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: {
            tools: false,
            vision: false,
            reasoning: false,
            midConversationSystem: false,
          },
          parameters: [],
        },
        {
          id: "m",
          displayName: "m",
          contextWindow: 8000,
          maxOutputTokens: 1000,
          capabilities: {
            tools: true,
            vision: false,
            reasoning: true,
            midConversationSystem: true,
          },
          parameters,
        },
      ];
    },
    async *stream(
      req: ModelRequest,
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
      if (question.includes("pencils")) content.push({ type: "thinking", text: "9 * 2 = 18" });
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
  plugin: "in-memory",
  provider: makeProvider(),
  model: "m",
  expect: { thinking: true, caching: true, embedding: { model: "e", dimensions: 8 } },
  async teardown() {},
}));

/** 模拟插件自带另一份 plugin-sdk：错误类不同但形状一致。 */
class ForeignModelError extends Error {
  readonly kind = "aborted";
}

describeModelProviderConformance("in-memory (duplicate sdk copy)", async () => ({
  plugin: "in-memory",
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

describeModelProviderConformance("in-memory with parameters", async () => ({
  plugin: "in-memory",
  provider: makeProvider(undefined, PARAMS),
  model: "m",
  expect: { thinking: true, caching: true },
  async teardown() {},
}));

/**
 * A provider declaring vision / documents: it answers the expected word only when it receives
 * valid sample media blocks, proving the media cases run and send the samples to the plugin in the
 * contract's shape.
 */
function makeMediaProvider(): ModelProvider {
  const base = makeProvider();
  return {
    async listModels() {
      const [m] = await base.listModels();
      if (m === undefined) throw new Error("no model");
      return [
        {
          ...m,
          capabilities: { ...m.capabilities, vision: true, documents: true },
          parameters: [],
        },
      ];
    },
    async *stream(req, opts): AsyncGenerator<ModelStreamEvent> {
      const last = req.messages[req.messages.length - 1];
      const media =
        last?.role === "user"
          ? last.content.find((b) => b.type === "image" || b.type === "document")
          : undefined;
      if (media === undefined) {
        yield* base.stream(req, opts);
        return;
      }
      expect(validateMediaBlock(media)).toEqual([]);
      const data = media.source.kind === "base64" ? media.source.data : "";
      const answer =
        media.type === "image"
          ? "Red."
          : media.mediaType === "application/pdf"
            ? MEDIA_SAMPLES.pdf.word
            : Buffer.from(data, "base64").toString("utf8").includes(MEDIA_SAMPLES.text.word)
              ? MEDIA_SAMPLES.text.word
              : "?";
      yield { type: "text_delta", text: answer };
      yield {
        type: "message_complete",
        content: [{ type: "text", text: answer }],
        stopReason: "end_turn",
        usage: usage(0),
      };
    },
  };
}

describeModelProviderConformance("in-memory with media", async () => ({
  plugin: "in-memory",
  provider: makeMediaProvider(),
  model: "m",
  expect: { thinking: true, caching: true },
  async teardown() {},
}));

describe("media samples", () => {
  it("red PNG is a valid PNG image block", () => {
    const data = redPngBase64();
    expect(Buffer.from(data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(
      validateMediaBlock({
        type: "image",
        mediaType: "image/png",
        source: { kind: "base64", data },
      }),
    ).toEqual([]);
  });
  it("PDF has correct xref offsets and prints the word", () => {
    const pdf = Buffer.from(pdfBase64("PINEAPPLE"), "base64").toString("latin1");
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf).toContain("(PINEAPPLE) Tj");
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => {
      expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(() => pdfBase64("not a word")).toThrow();
    expect(pdfSampleWord(pdfBase64("KIWI7"))).toBe("KIWI7");
    expect(pdfSampleWord(redPngBase64())).toBeNull();
    expect(isPngBase64(redPngBase64())).toBe(true);
    expect(isPngBase64(pdfBase64("KIWI"))).toBe(false);
  });
});

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

describe("thinkingReplayParams", () => {
  const knob = (key: "effort" | "thinking", values: string[], def?: string): ModelParameter => ({
    key,
    standard: key,
    schema: { type: "string", enum: values },
    ...(def !== undefined ? { default: def } : {}),
    label: { zh: key, en: key },
  });
  it("takes the highest declared effort tier and thinking summarized (else on), plus other defaults", () => {
    expect(
      thinkingReplayParams([
        knob("effort", ["max", "low", "high"], "high"),
        knob("thinking", ["on", "summarized"], "on"),
        {
          key: "p.style",
          schema: { type: "string", enum: ["a", "b"] },
          default: "b",
          label: { zh: "s", en: "s" },
        },
      ]),
    ).toEqual({ effort: "max", thinking: "summarized", "p.style": "b" });
    expect(
      thinkingReplayParams([knob("thinking", ["off", "on"]), knob("effort", ["low", "xhigh"])]),
    ).toEqual({
      thinking: "on",
      effort: "xhigh",
    });
  });
  it("sets nothing that is not declared", () => {
    expect(thinkingReplayParams([])).toEqual({});
    expect(thinkingReplayParams([knob("thinking", ["off"])])).toEqual({});
  });
});

describe("checkToolStream", () => {
  const done = (input: unknown, id = "call_1") =>
    ({
      type: "message_complete",
      content: [{ type: "tool_call", id, name: "Write", input }],
      stopReason: "tool_use",
      usage: usage(0),
    }) as Extract<ModelStreamEvent, { type: "message_complete" }>;

  it("accepts start plus deltas that join to the final input", () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "Write" },
      { type: "tool_call_delta", id: "call_1", input: '{"a":' },
      { type: "tool_call_delta", id: "call_1", input: "1}" },
    ];
    expect(checkToolStream(events, done({ a: 1 }))).toEqual([]);
  });

  it("compares the parsed input structurally, whatever the key order", () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "Write" },
      { type: "tool_call_delta", id: "call_1", input: '{"content":"x","file_path":"/a",' },
      { type: "tool_call_delta", id: "call_1", input: '"opts":{"b":2,"a":[1,{"d":1,"c":0}]}}' },
    ];
    const input = { file_path: "/a", content: "x", opts: { a: [1, { c: 0, d: 1 }], b: 2 } };
    expect(checkToolStream(events, done(input))).toEqual([]);
    // array order still matters
    const swapped = { ...input, opts: { a: [{ c: 0, d: 1 }, 1], b: 2 } };
    expect(checkToolStream(events, done(swapped))).toEqual([
      "streamed input of call_1 does not parse to the final input",
    ]);
  });

  it("rejects a repeated start for the same id, keeping the input streamed so far", () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "Write" },
      { type: "tool_call_delta", id: "call_1", input: '{"a":' },
      { type: "tool_call_start", id: "call_1", name: "Write" },
      { type: "tool_call_delta", id: "call_1", input: "1}" },
    ];
    expect(checkToolStream(events, done({ a: 1 }))).toEqual([
      "repeated tool_call_start for id call_1",
    ]);
  });

  it("rejects a delta before its start", () => {
    const events: ModelStreamEvent[] = [{ type: "tool_call_delta", id: "call_x", input: "{}" }];
    expect(checkToolStream(events, done({}))).toEqual(["tool_call_delta for unknown id call_x"]);
  });

  it("rejects streamed input that differs from the final input", () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "Write" },
      { type: "tool_call_delta", id: "call_1", input: '{"a":2}' },
    ];
    expect(checkToolStream(events, done({ a: 1 }))).toEqual([
      "streamed input of call_1 does not parse to the final input",
    ]);
  });

  it("accepts a started call that never reaches the final message", () => {
    const events: ModelStreamEvent[] = [
      { type: "tool_call_start", id: "call_gone", name: "Write" },
      { type: "tool_call_delta", id: "call_gone", input: '{"a":' },
    ];
    expect(checkToolStream(events, done({}))).toEqual([]);
  });

  it("accepts a stream with no tool events", () => {
    expect(checkToolStream([], done({}))).toEqual([]);
  });
});
