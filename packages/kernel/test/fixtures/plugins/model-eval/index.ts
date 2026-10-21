import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY_V2,
  type ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 评测测试用的模型供应商（model-provider@2）：模型 eval-1 / eval-2 / eval-v（视觉）/ eval-j（评委，回复
 * `judgeReply`）。声明一个插件用途 `model-eval.summarize`（`permissions.models`）。
 * 用量固定（每次请求 `tokens` 个输入 token，其余三项为 0），可设延迟、失败序列、「先流出文本再失败」。
 * 状态挂在 globalThis 上，测试与插件共享（同一进程，双内核也共用一份），用来核对收到的请求与最大并发；
 * 部署级配置 `replica` 标出是哪个内核实例发的请求（`seenBy` 与 `requests` 一一对应）。
 */
export interface EvalModelState {
  requests: ModelRequest[];
  /** 每个请求来自哪个内核实例（配置 `replica`，未配为 ""）。 */
  seenBy: string[];
  inflight: number;
  maxInflight: number;
  /** 每次请求回复前等待的毫秒数。 */
  delayMs: number;
  /** 每次请求报告的输入 token 数。 */
  tokens: number;
  /** 接下来的若干次请求依次抛出的错误（取出即用掉）。 */
  failures: ModelError[];
  /** 设了就让每个请求先流出这段文本、再抛这个错误（不产生 message_complete）。 */
  streamThenFail: { text: string; error: ModelError } | null;
  /** 模型 eval-j（评委）的回复文本。 */
  judgeReply: string;
}

/** eval-j 缺省的回复：合法的评委结论。 */
export const DEFAULT_JUDGE_REPLY = '{"verdict":"pass","score":4,"reason":"Same answer."}';

export function evalModelState(): EvalModelState {
  const g = globalThis as { __evalModel?: EvalModelState };
  g.__evalModel ??= {
    requests: [],
    seenBy: [],
    inflight: 0,
    maxInflight: 0,
    delayMs: 0,
    tokens: 100,
    failures: [],
    streamThenFail: null,
    judgeReply: DEFAULT_JUDGE_REPLY,
  };
  return g.__evalModel;
}

export function resetEvalModel(): void {
  const s = evalModelState();
  s.requests = [];
  s.seenBy = [];
  s.inflight = 0;
  s.maxInflight = 0;
  s.delayMs = 0;
  s.tokens = 100;
  s.failures = [];
  s.streamThenFail = null;
  s.judgeReply = DEFAULT_JUDGE_REPLY;
}

const info = (id: string, vision = false): ModelInfo => ({
  id,
  displayName: id,
  contextWindow: 32_000,
  maxOutputTokens: 2_000,
  capabilities: {
    tools: true,
    vision,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
  },
  parameters: [
    {
      key: "model-eval.level",
      schema: { type: "number", minimum: 0, maximum: 2 },
      default: 1,
      label: { zh: "档位", en: "Level" },
    },
  ],
});

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

const Deployment = z.object({ replica: z.string().optional() });

export default definePlugin({
  name: "model-eval",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY_V2],
  config: { deployment: Deployment },
  permissions: {
    models: [
      { purpose: "model-eval.summarize", kind: "chat", label: { zh: "摘要", en: "Summarize" } },
    ],
  },
  setup(ctx) {
    const replica = Deployment.parse(ctx.config ?? {}).replica ?? "";
    const provider: ModelProvider = {
      async listModels() {
        return [info("eval-1"), info("eval-2"), info("eval-v", true), info("eval-j")];
      },
      async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
        const s = evalModelState();
        s.requests.push(structuredClone(req));
        s.seenBy.push(replica);
        s.inflight++;
        s.maxInflight = Math.max(s.maxInflight, s.inflight);
        try {
          await sleep(s.delayMs, signal);
          const fail = s.failures.shift();
          if (fail) throw fail;
          if (s.streamThenFail) {
            yield { type: "text_delta", text: s.streamThenFail.text };
            throw s.streamThenFail.error;
          }
          yield {
            type: "message_complete",
            content: [
              {
                type: "text",
                text: req.model === "eval-j" ? s.judgeReply : `reply from ${req.model}`,
              },
            ],
            stopReason: "end_turn",
            usage: {
              inputTokens: s.tokens,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        } finally {
          s.inflight--;
        }
      },
    };
    ctx.provide(MODEL_PROVIDER_CAPABILITY_V2, provider);
  },
});
