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
     * 是否接受 `document` 块（缺省为 false）。图片看 `vision`。模型不支持时内核把媒体块换成英文文字占位
     * （如 `[Attached image "<name>" — this model cannot view images.]`；`text/*` 文档改为内联截断后的文本），
     * 绝不把字节发给它。
     */
    documents?: boolean;
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

/** 图片块接受的类型。 */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** 文档块接受的类型。 */
export const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

/**
 * 媒体内容的来源：`base64` 是字节本身，`ref` 是内核附件的引用。
 * 事件日志里只存 `ref`（字节不进日志）；内核构建请求时把 `ref` 解析成 `base64`，插件只会收到 `base64`。
 */
export type MediaSource = { kind: "base64"; data: string } | { kind: "ref"; attachmentId: string };

/** 单个媒体块解码后的字节上限（按主流供应商的较小值取）。 */
export const MEDIA_LIMITS = { imageBytes: 5_242_880, documentBytes: 33_554_432 } as const;

export type ContentBlock =
  /** text 的 opaque：供应商需要随文本回放的私有数据（如 OpenAI message 输出项的 id）。 */
  | { type: "text"; text: string; opaque?: ProviderOpaque }
  | { type: "thinking"; text: string; opaque?: ProviderOpaque }
  | { type: "tool_call"; id: string; name: string; input: unknown; opaque?: ProviderOpaque }
  | { type: "tool_result"; callId: string; content: string; isError: boolean }
  /**
   * 图片（只出现在 user 消息里）。模型不支持 `vision` 时内核换成文字占位，插件不用把关；
   * 不认识此块的旧插件会跳过它。
   */
  | { type: "image"; mediaType: ImageMediaType; source: MediaSource; name?: string }
  /** 文档（只出现在 user 消息里），由 `capabilities.documents` 把关，规则同 image。 */
  | { type: "document"; mediaType: DocumentMediaType; source: MediaSource; name?: string };

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 媒体块 `name` 的最大长度（字符）。 */
export const MEDIA_NAME_MAX_CHARS = 255;

/** 供应商请求里文件名 / 标题的建议上限（码点），{@link clipMediaName} 的默认值。 */
export const PROVIDER_MEDIA_NAME_MAX = 200;

/**
 * 把附件名截到 `max` 个码点以内（供应商映射用：有的接口对 filename / title 有长度限制，补后缀后还会更长）。
 * 尽量保留扩展名（不超过 16 个字符的 `.ext`），中间用 `…` 表示截掉的部分。纯函数。
 */
export function clipMediaName(name: string, max = PROVIDER_MEDIA_NAME_MAX): string {
  const cps = [...name];
  if (cps.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? [...name.slice(dot)] : [];
  const keep = ext.length > 0 && ext.length <= 16 && ext.length < max - 1 ? ext : [];
  const head = cps.slice(0, max - 1 - keep.length);
  return `${head.join("")}…${keep.join("")}`;
}

/** 是否含控制字符（C0、DEL 与 C1）。 */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** 附件 id 是否为 UUID（任意版本，大小写不限）。 */
export function isAttachmentId(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
const MEDIA: Record<string, { types: readonly string[]; limit: number }> = {
  image: { types: IMAGE_MEDIA_TYPES, limit: MEDIA_LIMITS.imageBytes },
  document: { types: DOCUMENT_MEDIA_TYPES, limit: MEDIA_LIMITS.documentBytes },
};

/**
 * 校验一个 image / document 块，返回错误列表（空表示合法）：类型在列表里；`base64` 是标准、带填充、
 * 不含空白的 base64，解码后不超过 {@link MEDIA_LIMITS}；`ref` 的 `attachmentId` 是 UUID；`name` 若有须是字符串、
 * 不超过 {@link MEDIA_NAME_MAX_CHARS} 个字符且不含控制字符。
 */
export function validateMediaBlock(b: unknown): string[] {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return ["block must be an object"];
  const o = b as Record<string, unknown>;
  const spec =
    typeof o.type === "string" && Object.hasOwn(MEDIA, o.type) ? MEDIA[o.type] : undefined;
  if (!spec) return ['block type must be "image" or "document"'];
  const errs: string[] = [];
  if (typeof o.mediaType !== "string" || !spec.types.includes(o.mediaType)) {
    errs.push(`${o.type} mediaType must be one of ${spec.types.join(", ")}`);
  }
  if (o.name !== undefined) {
    if (typeof o.name !== "string") errs.push(`${o.type} name must be a string`);
    else if (o.name.length > MEDIA_NAME_MAX_CHARS) {
      errs.push(`${o.type} name must be at most ${MEDIA_NAME_MAX_CHARS} characters`);
    } else if (hasControlChars(o.name)) {
      errs.push(`${o.type} name must not contain control characters`);
    }
  }
  const src = o.source;
  if (typeof src !== "object" || src === null) {
    errs.push(`${o.type} source must be an object`);
    return errs;
  }
  const source = src as Record<string, unknown>;
  if (source.kind === "ref") {
    if (!isAttachmentId(source.attachmentId)) {
      errs.push(`${o.type} source.attachmentId must be a UUID`);
    }
  } else if (source.kind === "base64") {
    const data = source.data;
    if (typeof data !== "string" || data === "" || data.length % 4 !== 0) {
      errs.push(`${o.type} source.data must be non-empty padded base64`);
      return errs;
    }
    // 先按长度算解码后的大小，超限就不再逐字符校验
    const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = (data.length / 4) * 3 - pad;
    if (bytes > spec.limit) {
      errs.push(`${o.type} is ${bytes} bytes, over the limit of ${spec.limit} bytes`);
    } else if (!B64_RE.test(data)) {
      errs.push(`${o.type} source.data is not valid base64`);
    }
  } else {
    errs.push(`${o.type} source.kind must be "base64" or "ref"`);
  }
  return errs;
}

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
  tools: ToolDefinition[];
  /**
   * `@2`：模型可否调用工具。`"none"` = 本次只能回复文本、不得调用工具（`tools` 仍照常带上：历史里有工具调用时
   * 部分供应商要求请求声明工具，且保持缓存前缀稳定）；缺省或 `"auto"` = 由模型决定。
   * 插件映射到原生字段（如 Anthropic `tool_choice: {type: "none"}`）；`tools` 为空时插件不发送该字段。
   */
  toolChoice?: "auto" | "none";
  maxOutputTokens: number;
  /** `@2`：本次调用的参数（已按该模型的 `parameters` 处理过），由插件映射到原生请求。 */
  params: Record<string, ParamValue>;
  /** @deprecated `model-provider@1` 用；`@2` 插件读 `params.effort`。 */
  effort?: Effort;
}

/** `model-provider@1` 的请求：没有 `params` 与 `toolChoice`。 */
export type ModelRequestV1 = Omit<ModelRequest, "params" | "toolChoice">;

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

export const MODEL_PROVIDER_EXTENSION_POINT = "model-provider@1";
export const MODEL_PROVIDER_EXTENSION_POINT_V2 = "model-provider@2";
