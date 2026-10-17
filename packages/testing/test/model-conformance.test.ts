import {
  type ContentBlock,
  ModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { describeModelProviderConformance } from "../src/index.js";

const usage = (cacheRead: number) => ({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
});

/** 内存中的最小供应商：仅用于证明一致性套件可运行。 */
function makeProvider(): ModelProvider {
  const seen = new Set<string>();
  return {
    async listModels() {
      return [];
    },
    async *stream(
      req: ModelRequest,
      opts: { signal: AbortSignal },
    ): AsyncGenerator<ModelStreamEvent> {
      const aborted = () => new ModelError("aborted", "aborted");
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
