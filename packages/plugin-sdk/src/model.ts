/** model-provider@1：与供应商无关的模型契约；原生协议留在各供应商插件内部。 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    caching: boolean;
    midConversationSystem: boolean;
    effort: boolean;
  };
  /** 流空闲看门狗阈值；推理类模型应更长。未给时内核用配置默认值。 */
  streamIdleTimeoutMs?: number;
}

/** 供应商私有数据：只回放给同一供应商（如 Anthropic 思考块签名、OpenAI 加密推理项）。 */
export interface ProviderOpaque {
  provider: string;
  model: string;
  data: unknown;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; opaque?: ProviderOpaque }
  | { type: "tool_call"; id: string; name: string; input: unknown; opaque?: ProviderOpaque }
  | { type: "tool_result"; callId: string; content: string; isError: boolean };

export type ModelMessage =
  | { role: "user"; content: ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[] }
  /** 对话中途的系统提醒；模型不支持时由插件转成 user 文本块（以 "[system] " 开头）。 */
  | { role: "system"; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  /** 稳定内容在前；cache 为 true 的块之后打缓存断点（由插件按原生协议实现）。 */
  system: { text: string; cache: boolean }[];
  messages: ModelMessage[];
  tools: ToolDefinition[]; // M2 恒为 []
  maxOutputTokens: number;
  effort?: Effort;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "message_complete";
      content: ContentBlock[];
      stopReason: StopReason;
      usage: ModelUsage;
    };

export type ModelErrorKind =
  | "rate_limited"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "auth"
  | "invalid_request"
  | "context_overflow"
  | "aborted";

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set([
  "rate_limited",
  "overloaded",
  "server",
  "timeout",
  "network",
]);

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly retryAfterMs?: number;

  constructor(
    kind: ModelErrorKind,
    message: string,
    opts?: { retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "ModelError";
    this.kind = kind;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  /** rate_limited / overloaded / server / timeout / network 为 true。 */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  /** 事件序列必须以且仅以一个 message_complete 结束；出错抛 ModelError。 */
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}

export const MODEL_PROVIDER_CAPABILITY = "model-provider@1";
