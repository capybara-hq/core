/**
 * 与供应商无关的模型契约；原生协议留在各供应商插件内部。
 * 当前契约为 `model-provider@2`（`ModelProvider` / `ModelInfo` / `ModelRequest`，参数由插件按模型声明，
 * 见 `model-params.ts`）；旧契约 `model-provider@1`（`ModelProviderV1` 等）由内核经适配层继续支持。
 */
import type { Effort, ModelParameter, ParamValue } from "./model-params.js";

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
    /**
     * @deprecated `model-provider@1` 用：是否支持 `ModelRequestV1.effort`。`@2` 插件不填，改在
     * `parameters` 中声明 `effort` 旋钮；内核的 `@1` 适配层据此推导 `parameters`。
     */
    effort?: boolean;
  };
  /** 流空闲看门狗阈值；推理类模型应更长。未给时内核用配置默认值。 */
  streamIdleTimeoutMs?: number;
  /** 该模型支持的参数（`@2` 必填，可为空数组；须通过 `assertValidDeclarations`）。 */
  parameters: ModelParameter[];
}

/** `model-provider@1` 的模型信息：没有 `parameters`，effort 支持由 `capabilities.effort` 表示。 */
export type ModelInfoV1 = Omit<ModelInfo, "parameters" | "capabilities"> & {
  capabilities: Omit<ModelInfo["capabilities"], "effort"> & { effort: boolean };
};

/** 供应商私有数据：只回放给同一供应商（如 Anthropic 思考块签名、OpenAI 加密推理项）。 */
export interface ProviderOpaque {
  provider: string;
  model: string;
  data: unknown;
}

export type ContentBlock =
  /** text 的 opaque：供应商需要随文本回放的私有数据（如 OpenAI message 输出项的 id）。 */
  | { type: "text"; text: string; opaque?: ProviderOpaque }
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
  /** `@2`：本次调用的参数（已按该模型的 `parameters` 处理过），由插件映射到原生请求。 */
  params: Record<string, ParamValue>;
  /** @deprecated `model-provider@1` 用；`@2` 插件读 `params.effort`。 */
  effort?: Effort;
}

/** `model-provider@1` 的请求：没有 `params`。 */
export type ModelRequestV1 = Omit<ModelRequest, "params">;

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/**
 * 一次调用的 token 用量。三类输入互不重叠：本次请求的输入总量 =
 * `inputTokens + cacheReadTokens + cacheWriteTokens`（内核据此校正上下文估算、决定何时压缩）。
 * 供应商 API 的输入计数若已包含缓存命中 / 写入的 token（如 OpenAI 的 `prompt_tokens`），插件必须先减掉。
 */
export interface ModelUsage {
  /** 未命中缓存、也未写入缓存的输入 token（只是未缓存部分，不是输入总量）。 */
  inputTokens: number;
  outputTokens: number;
  /** 从提示词缓存读取的输入 token。 */
  cacheReadTokens: number;
  /** 本次写入提示词缓存的输入 token。 */
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

const ALL_KINDS: ReadonlySet<string> = new Set<ModelErrorKind>([
  "rate_limited",
  "overloaded",
  "server",
  "timeout",
  "network",
  "auth",
  "invalid_request",
  "context_overflow",
  "aborted",
]);

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set<ModelErrorKind>([
  "rate_limited",
  "overloaded",
  "server",
  "timeout",
  "network",
]);

/** rate_limited / overloaded / server / timeout / network 为 true。 */
export function isRetryableKind(kind: ModelErrorKind): boolean {
  return RETRYABLE.has(kind);
}

/** 鸭子类型判断（不用 instanceof），兼容插件自带另一份 plugin-sdk 副本的情况。 */
export function isModelError(e: unknown): e is ModelError {
  if (!(e instanceof Error)) return false;
  const kind = (e as { kind?: unknown }).kind;
  return typeof kind === "string" && ALL_KINDS.has(kind);
}

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
    return isRetryableKind(this.kind);
  }
}

/** `model-provider@2` 的实现。 */
export interface ModelProvider {
  /** 每个模型的 `parameters` 须通过 `assertValidDeclarations`，否则内核不使用该供应商。 */
  listModels(): Promise<ModelInfo[]>;
  /** 事件序列必须以且仅以一个 message_complete 结束；出错抛 ModelError。 */
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}

/** `model-provider@1` 的实现（旧契约，内核经适配层接入：effort 由 `capabilities.effort` 推导）。 */
export interface ModelProviderV1 {
  listModels(): Promise<ModelInfoV1[]>;
  /** 事件序列必须以且仅以一个 message_complete 结束；出错抛 ModelError。 */
  stream(req: ModelRequestV1, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}

export const MODEL_PROVIDER_CAPABILITY = "model-provider@1";
export const MODEL_PROVIDER_CAPABILITY_V2 = "model-provider@2";
