import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY_V2,
  type ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";

/**
 * 评测测试用的模型供应商（model-provider@2）：模型 eval-1 / eval-2 / eval-v（视觉），固定回复与用量（每次请求 `tokens` 个输入 token，
 * 其余三项为 0），可设延迟与失败。状态挂在 globalThis 上，测试与插件共享（同一进程，双内核也共用一份），
 * 用来核对收到的请求与最大并发。
 */
export interface EvalModelState {
  requests: ModelRequest[];
  inflight: number;
  maxInflight: number;
  /** 每次请求回复前等待的毫秒数。 */
  delayMs: number;
  /** 每次请求报告的输入 token 数。 */
  tokens: number;
  /** 接下来的若干次请求依次抛出的错误（取出即用掉）。 */
  failures: ModelError[];
}

export function evalModelState(): EvalModelState {
  const g = globalThis as { __evalModel?: EvalModelState };
  g.__evalModel ??= {
    requests: [],
    inflight: 0,
    maxInflight: 0,
    delayMs: 0,
    tokens: 100,
    failures: [],
  };
  return g.__evalModel;
}

export function resetEvalModel(): void {
  const s = evalModelState();
  s.requests = [];
  s.inflight = 0;
  s.maxInflight = 0;
  s.delayMs = 0;
  s.tokens = 100;
  s.failures = [];
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

export default definePlugin({
  name: "model-eval",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY_V2],
  setup(ctx) {
    const provider: ModelProvider = {
      async listModels() {
        return [info("eval-1"), info("eval-2"), info("eval-v", true)];
      },
      async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
        const s = evalModelState();
        s.requests.push(structuredClone(req));
        s.inflight++;
        s.maxInflight = Math.max(s.maxInflight, s.inflight);
        try {
          await sleep(s.delayMs, signal);
          const fail = s.failures.shift();
          if (fail) throw fail;
          yield {
            type: "message_complete",
            content: [{ type: "text", text: `reply from ${req.model}` }],
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
