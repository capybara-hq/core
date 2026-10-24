import { randomUUID } from "node:crypto";
import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT,
  ModelError,
  type ModelProviderV1,
  type ModelRequestV1,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";

/**
 * 测试用模型供应商（模型 `loop-1`）：按最近一条带文本的 user 消息决定行为。
 * - `loop:<ms>`：等待 ms 毫秒（可中止）后返回一个 `noop` 工具调用（stopReason `tool_use`）——
 *   `model-fake` 的 `tool:` 指令在下一步会看到补出的 tool_result 而转为文本，这里每步都继续调用工具；
 * - 请求末尾是收尾提醒（`Step limit reached`）→ 文本 `wrapped up`；
 * - 其他文本 → `You said: <text>`（流式，每 4 字符一块）。
 */
function lastUserText(req: ModelRequestV1): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (text !== "") return text;
  }
  return "";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ModelError("aborted", "Request aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelError("aborted", "Request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

export default defineExtension({
  name: "model-looper",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT],
  setup(ctx) {
    const provider: ModelProviderV1 = {
      async listModels() {
        return [
          {
            id: "loop-1",
            displayName: "loop-1",
            contextWindow: 32_000,
            maxOutputTokens: 4096,
            capabilities: {
              tools: true,
              vision: false,
              reasoning: false,
              caching: false,
              midConversationSystem: true,
              effort: false,
            },
          },
        ];
      },
      async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
        const last = req.messages.at(-1);
        if (last?.role === "system" && last.content.startsWith("Step limit reached")) {
          yield { type: "text_delta", text: "wrapped up" };
          yield {
            type: "message_complete",
            content: [{ type: "text", text: "wrapped up" }],
            stopReason: "end_turn",
            usage,
          };
          return;
        }
        const text = lastUserText(req);
        const loop = /^loop:(\d+)$/.exec(text);
        if (loop) {
          await wait(Number(loop[1]), signal);
          yield {
            type: "message_complete",
            content: [{ type: "tool_call", id: randomUUID(), name: "noop", input: {} }],
            stopReason: "tool_use",
            usage,
          };
          return;
        }
        const out = `You said: ${text}`;
        for (let i = 0; i < out.length; i += 4) {
          await wait(1, signal);
          yield { type: "text_delta", text: out.slice(i, i + 4) };
        }
        yield {
          type: "message_complete",
          content: [{ type: "text", text: out }],
          stopReason: "end_turn",
          usage,
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT, provider);
  },
});
