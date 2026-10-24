import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  ModelError,
  type ModelProvider,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 跨进程可控的评委模型（model-provider@2，模型 judge-1），供双副本测试用。协调全靠部署配置 `dir` 指向的
 * 共享目录（副本是独立进程，globalThis 不共享）：
 * - 每个请求一到就写标记文件 `inflight-<pid>-<uuid>`，测试由此看到「哪个进程的评委请求在途」；
 * - 之后一直等到目录里出现 `release` 才回复（每 20ms 查一次，可被 signal 中止）——测试决定何时放行；
 * - 回复是合法的评委结论：候选回复以 `Tool call:` 开头（工具调用）→ pass / 4，否则 → fail / 2；
 * - 用量固定：输入 50、输出 10。
 */

/** 每次评委请求计入的 token（输入 50 + 输出 10）。 */
export const JUDGE_GATE_TOKENS = 60;
export const RELEASE_FILE = "release";
export const INFLIGHT_PREFIX = "inflight-";

const Deployment = z.object({ dir: z.string().min(1) });

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const tick = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ModelError("aborted", "Request aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ModelError("aborted", "Request aborted"));
      },
      { once: true },
    );
  });

/** 评委用户消息是 `Evaluate the following data:\n<JSON>`；取 JSON 里的候选回复。 */
function candidateOf(text: string): string {
  try {
    const data = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { candidateResponse?: unknown };
    return typeof data.candidateResponse === "string" ? data.candidateResponse : "";
  } catch {
    return "";
  }
}

export default defineExtension({
  name: "judge-gate",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: Deployment },
  setup(ctx) {
    const { dir } = Deployment.parse(ctx.config ?? {});
    const provider: ModelProvider = {
      async listModels() {
        return [
          {
            id: "judge-1",
            displayName: "judge-1",
            contextWindow: 32_000,
            maxOutputTokens: 2_000,
            capabilities: {
              tools: false,
              vision: false,
              reasoning: false,
              caching: false,
              midConversationSystem: true,
            },
            parameters: [],
          },
        ];
      },
      async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
        await writeFile(join(dir, `${INFLIGHT_PREFIX}${process.pid}-${randomUUID()}`), "");
        while (!(await exists(join(dir, RELEASE_FILE)))) await tick(20, signal);
        const last = req.messages.at(-1);
        const text =
          last && last.role !== "system"
            ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("")
            : "";
        const pass = candidateOf(text).startsWith("Tool call:");
        const verdict = pass
          ? { verdict: "pass", score: 4, reason: "Same tool call." }
          : { verdict: "fail", score: 2, reason: "Text reply." };
        yield {
          type: "message_complete",
          content: [{ type: "text", text: JSON.stringify(verdict) }],
          stopReason: "end_turn",
          usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
