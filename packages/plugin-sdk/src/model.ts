/**
 * The vendor-neutral model contract; native protocols stay inside each vendor plugin.
 * The contract is `model-provider@2` (`ModelProvider` / `ModelInfo` / `ModelRequest`, parameters
 * declared by the plugin per model, see `model-params.ts`).
 */
import type { ModelCallPurpose } from "./hooks.js";
import type { ModelParameter, ParamValue } from "./model-params.js";
import type { LocalizedName } from "./plugin-package.js";

/**
 * What a model does. Absent on a `ModelInfo` means `chat`. Callable kinds: `chat` (`stream`),
 * `embedding` (`embed`) and `image_generation` (`generateImage`); the others are list-only.
 */
export type ModelKind =
  | "chat"
  | "embedding"
  | "rerank"
  | "image_generation"
  | "video_generation"
  | "speech_to_text"
  | "text_to_speech";

/** Embedding facts of a model whose `kind` is `embedding`. */
export interface ModelEmbeddingInfo {
  /** The output dimensions the model can produce (a single entry when not adjustable). */
  dimensions: number[];
  defaultDimensions: number;
  /** Most tokens one input may hold. */
  maxInputTokens: number;
  /** Most inputs one `embed` call may carry. */
  maxBatch: number;
}

/** An output size of an image generation model, in pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

/** The aspect ratios a caller may ask for instead of an exact size. */
export const IMAGE_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/** Image generation facts of a model whose `kind` is `image_generation`. */
export interface ModelImageGenerationInfo {
  /** The output sizes the model offers. */
  sizes: ImageSize[];
  /** One of `sizes`, used when the caller asks for none. */
  defaultSize: ImageSize;
  /** Most images one `generateImage` call may produce. */
  maxImages: number;
  /** Most reference images one call may carry (0 = text to image only). */
  maxReferenceImages: number;
  /** The media types the model returns. */
  outputMediaTypes: ImageMediaType[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Defaults to `chat`. Chat-only fields below stay required for every kind. */
  kind?: ModelKind;
  /** Who made the model (display only). */
  publisher?: string;
  /** Display only. */
  description?: LocalizedName | string;
  /** ISO date after which the model is retired (display only). */
  retiresAt?: string;
  /** Set when `kind` is `embedding`. */
  embedding?: ModelEmbeddingInfo;
  /** Set when `kind` is `image_generation`. */
  imageGeneration?: ModelImageGenerationInfo;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    caching: boolean;
    midConversationSystem: boolean;
    /**
     * Whether `document` blocks are accepted (default false). Images are governed by `vision`. When
     * the model does not support them the kernel replaces media blocks with English text
     * placeholders
     * (e.g. `[Attached image "<name>" — this model cannot view images.]`; `text/*` documents are
     * inlined as truncated text instead),
     * and never sends the bytes to it.
     */
    documents?: boolean;
  };
  /**
   * Stream idle watchdog threshold; reasoning models should use a longer one. When unset the kernel
   * uses the config default.
   */
  streamIdleTimeoutMs?: number;
  /**
   * The parameters this model supports (may be an empty array; must pass
   * `assertValidDeclarations`). Effort is the standard `effort` knob declared here.
   */
  parameters: ModelParameter[];
}

/**
 * Vendor-private data: replayed only to the same vendor (e.g. Anthropic thinking block signatures,
 * OpenAI encrypted reasoning items).
 */
export interface ProviderOpaque {
  provider: string;
  model: string;
  data: unknown;
}

/** Types accepted by image blocks. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Types accepted by document blocks. */
export const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

/**
 * The source of media content: `base64` is the bytes themselves, `ref` is a reference to a kernel
 * attachment.
 * The event log stores only `ref` (bytes never enter the log); when building a request the kernel
 * resolves `ref` into `base64`, so plugins only ever receive `base64`.
 */
export type MediaSource = { kind: "base64"; data: string } | { kind: "ref"; attachmentId: string };

/**
 * Upper bound on the decoded bytes of a single media block (the smaller value among mainstream
 * vendors).
 */
export const MEDIA_LIMITS = { imageBytes: 5_242_880, documentBytes: 33_554_432 } as const;

export type ContentBlock =
  /**
   * Opaque for text: vendor-private data that must be replayed with the text (e.g. the id of an
   * OpenAI message output item).
   */
  | { type: "text"; text: string; opaque?: ProviderOpaque }
  | { type: "thinking"; text: string; opaque?: ProviderOpaque }
  | { type: "tool_call"; id: string; name: string; input: unknown; opaque?: ProviderOpaque }
  | { type: "tool_result"; callId: string; content: string; isError: boolean }
  /**
   * An image (only in user messages). When the model has no `vision` the kernel sends an English
   * placeholder instead; a plugin need not check. An older plugin that does not know this block
   * skips it. `size` is display metadata (the UI chip, the reference line) and is never sent.
   */
  | { type: "image"; mediaType: ImageMediaType; source: MediaSource; name?: string; size?: number }
  /** A document (only in user messages), gated by `capabilities.documents`; same rules as image. */
  | {
      type: "document";
      mediaType: DocumentMediaType;
      source: MediaSource;
      name?: string;
      size?: number;
    }
  /**
   * An attachment whose content the model cannot read (an xlsx, say): the kernel replaces it with
   * text carrying an unsigned object reference before the request, so a provider **never** receives
   * this block. `mediaType` is any non-empty `type/subtype`; `size` is display metadata (the UI
   * chip, the reference line) and is never sent.
   */
  | { type: "file"; mediaType: string; source: MediaSource; name?: string; size?: number };

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum length (characters) of a media block's `name`. */
export const MEDIA_NAME_MAX_CHARS = 255;

/**
 * Suggested upper bound (code points) for file names / titles in vendor requests, the default of
 * {@link clipMediaName}.
 */
export const PROVIDER_MEDIA_NAME_MAX = 200;

/**
 * Truncates an attachment name to at most `max` code points (for vendor mapping: some APIs limit
 * filename / title length, and adding a suffix makes it longer still).
 * Keeps the extension where possible (a `.ext` of at most 16 characters), with `…` marking the cut
 * part in the middle. A pure function.
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

/** Whether it contains control characters (C0, DEL and C1). */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Whether the attachment id is a UUID (any version, case-insensitive). */
export function isAttachmentId(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
/** Any non-empty `type/subtype` (a `file` block's `mediaType`). */
const MEDIA_TYPE_RE = /^[^/\s]+\/[^/\s]+$/;
const MEDIA: Record<string, { types: readonly string[]; limit: number; anyType?: boolean }> = {
  image: { types: IMAGE_MEDIA_TYPES, limit: MEDIA_LIMITS.imageBytes },
  document: { types: DOCUMENT_MEDIA_TYPES, limit: MEDIA_LIMITS.documentBytes },
  // A file the model cannot read: the kernel resolves it to text before the request, so no media
  // type list applies. The byte ceiling is the one attachments already have.
  file: { types: [], limit: MEDIA_LIMITS.documentBytes, anyType: true },
};

/**
 * Validates an image / document / file block, returning a list of errors (empty means valid): the
 * media type is in the block kind's list (`file` accepts any non-empty `type/subtype`); `base64` is
 * standard, padded, whitespace-free base64 that decodes to at most {@link MEDIA_LIMITS}; a `ref`'s
 * `attachmentId` is a UUID; `name`, when present, is a string of at most
 * {@link MEDIA_NAME_MAX_CHARS} characters with no control characters; `size`, when present, is a
 * non-negative integer (display metadata, never sent by a plugin).
 */
export function validateMediaBlock(b: unknown): string[] {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return ["block must be an object"];
  const o = b as Record<string, unknown>;
  const spec =
    typeof o.type === "string" && Object.hasOwn(MEDIA, o.type) ? MEDIA[o.type] : undefined;
  if (!spec) return ['block type must be "image", "document" or "file"'];
  const errs: string[] = [];
  if (spec.anyType) {
    if (
      typeof o.mediaType !== "string" ||
      !MEDIA_TYPE_RE.test(o.mediaType) ||
      hasControlChars(o.mediaType)
    ) {
      errs.push(`${o.type} mediaType must be a non-empty type/subtype string`);
    }
  } else if (typeof o.mediaType !== "string" || !spec.types.includes(o.mediaType)) {
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
  if (
    o.size !== undefined &&
    (typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < 0)
  ) {
    errs.push(`${o.type} size must be a non-negative integer`);
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
    // Compute the decoded size from the length first; when over the limit, skip the per-character
    // validation
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
  /**
   * A mid-conversation system reminder; when the model does not support it the plugin turns it into
   * a user text block (starting with "[system] ").
   */
  | { role: "system"; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  /**
   * Stable content first; after a block with cache true a cache breakpoint is placed (implemented
   * by the plugin per the native protocol).
   */
  system: { text: string; cache: boolean }[];
  messages: ModelMessage[];
  tools: ToolDefinition[];
  /**
   * `@2`: whether the model may call tools. `"none"` = this call may only reply with text and must
   * not call tools (`tools` is still sent as usual: when the history has tool calls
   * some vendors require the request to declare tools, and it keeps the cache prefix stable);
   * omitted or `"auto"` = the model decides.
   * The plugin maps it to the native field (e.g. Anthropic `tool_choice: {type: "none"}`); when
   * `tools` is empty the plugin does not send the field.
   */
  toolChoice?: "auto" | "none";
  maxOutputTokens: number;
  /**
   * The parameters of this call (already processed against the model's `parameters`), mapped to the
   * native request by the plugin.
   */
  params: Record<string, ParamValue>;
  /**
   * What this call is for, when the kernel says so: `"compaction"` for a conversation summary call.
   * Absent on ordinary step calls. Informational (a scripted test model keys on it); real providers
   * ignore it and must not forward it to a vendor API.
   */
  purpose?: ModelCallPurpose;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/**
 * Token usage of one call. The three kinds of input do not overlap: the total input of this request
 * =
 * `inputTokens + cacheReadTokens + cacheWriteTokens` (the kernel uses it to correct context
 * estimates and to decide when to compact).
 * If the vendor API's input count already includes cache-hit / cache-write tokens (e.g. OpenAI's
 * `prompt_tokens`), the plugin must subtract them first.
 */
export interface ModelUsage {
  /**
   * Input tokens that neither hit the cache nor were written to it (only the uncached part, not the
   * total input).
   */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache in this call. */
  cacheWriteTokens: number;
  /** Images produced (image generation calls). */
  outputImages?: number;
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
  | "refusal"
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
  "refusal",
  "aborted",
]);

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set<ModelErrorKind>([
  "rate_limited",
  "overloaded",
  "server",
  "timeout",
  "network",
]);

/** True for rate_limited / overloaded / server / timeout / network. */
export function isRetryableKind(kind: ModelErrorKind): boolean {
  return RETRYABLE.has(kind);
}

/**
 * Duck-typed check (no instanceof), compatible with a plugin bundling another copy of plugin-sdk.
 */
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

  /** True for rate_limited / overloaded / server / timeout / network. */
  get retryable(): boolean {
    return isRetryableKind(this.kind);
  }
}

/**
 * Options of a model call made for an organization.
 * `config` is the extension's effective deployment config for this org: the platform's deployment
 * config with the org's copy applied to the overridable fields (`orgAccess(…, "override")`), or the
 * platform's config (equal to `ctx.config`) while the org follows it. Use it, not `ctx.config`, for
 * work done for this org. Optional in the type so older providers compile; the kernel always passes
 * both.
 */
export interface ModelCallOptions {
  orgId?: string;
  config?: unknown;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  /** One of the model's `embedding.dimensions`; the model's default when absent. */
  dimensions?: number;
  inputType?: "query" | "document";
}

export interface EmbedResult {
  /** One vector per input, in input order. */
  vectors: number[][];
  usage: { inputTokens: number };
}

/**
 * Checks an embedding result against its request and the model's embedding facts. Returns null when
 * valid, else the reason: wrong vector count, wrong dimension, or a non-finite number.
 */
export function validateEmbedResult(
  req: EmbedRequest,
  info: ModelEmbeddingInfo,
  res: EmbedResult,
): string | null {
  if (res.vectors.length !== req.input.length) {
    return `vector count ${res.vectors.length} does not match input count ${req.input.length}`;
  }
  const dims = req.dimensions ?? info.defaultDimensions;
  for (let i = 0; i < res.vectors.length; i++) {
    const v = res.vectors[i] as number[];
    if (v.length !== dims) {
      return `vector ${i} has dimension ${v.length}, expected ${dims}`;
    }
    for (const x of v) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        return `vector ${i} holds a non-finite number`;
      }
    }
  }
  return null;
}

export interface ImageGenerateRequest {
  model: string;
  prompt: string;
  /** One of the model's `imageGeneration.sizes`. */
  size: ImageSize;
  /** Images to produce, 1 to `imageGeneration.maxImages`. */
  n: number;
  /** Base64 reference images, at most `imageGeneration.maxReferenceImages`. */
  referenceImages?: { mediaType: ImageMediaType; data: string }[];
  params: Record<string, ParamValue>;
}

export interface ImageGenerateResult {
  /** Exactly `req.n` images, base64 encoded. */
  images: { mediaType: ImageMediaType; data: string }[];
  /** The prompt as the vendor rewrote it, when it did. */
  revisedPrompt?: string;
  usage: ModelUsage;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** True when `x` is a well-formed {@link ModelImageGenerationInfo}. */
export function isValidImageGenerationInfo(x: unknown): x is ModelImageGenerationInfo {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const isSize = (s: unknown): s is ImageSize =>
    typeof s === "object" &&
    s !== null &&
    Number.isInteger((s as ImageSize).width) &&
    Number.isInteger((s as ImageSize).height) &&
    (s as ImageSize).width > 0 &&
    (s as ImageSize).height > 0;
  if (!Array.isArray(o.sizes) || o.sizes.length === 0 || !o.sizes.every(isSize)) return false;
  if (!isSize(o.defaultSize)) return false;
  const d = o.defaultSize;
  if (!o.sizes.some((s: ImageSize) => s.width === d.width && s.height === d.height)) return false;
  if (!Number.isInteger(o.maxImages) || (o.maxImages as number) < 1) return false;
  if (!Number.isInteger(o.maxReferenceImages) || (o.maxReferenceImages as number) < 0) {
    return false;
  }
  return (
    Array.isArray(o.outputMediaTypes) &&
    o.outputMediaTypes.length > 0 &&
    o.outputMediaTypes.every((t) => (IMAGE_MEDIA_TYPES as readonly unknown[]).includes(t))
  );
}

/**
 * Checks an image generation result against its request and the model's facts. Returns null when
 * valid, else the reason: wrong image count, an undeclared media type, data that is not base64,
 * or a `usage` that is not an object whose token counts (and `outputImages`, when present) are
 * non-negative integers (a caller records usage from it, so it is checked before anything is).
 */
export function validateImageGenerateResult(
  req: ImageGenerateRequest,
  info: ModelImageGenerationInfo,
  res: unknown,
): string | null {
  const images = (res as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return "result has no images array";
  if (images.length !== req.n) return `expected ${req.n} images, got ${images.length}`;
  for (let i = 0; i < images.length; i++) {
    const img = images[i] as { mediaType?: unknown; data?: unknown } | null;
    const type = img?.mediaType;
    if (typeof type !== "string" || !(info.outputMediaTypes as string[]).includes(type)) {
      return `image ${i} has media type ${String(type)}, not one of ${info.outputMediaTypes.join(", ")}`;
    }
    if (typeof img?.data !== "string" || !BASE64.test(img.data)) {
      return `image ${i} data is not base64`;
    }
  }
  const usage = (res as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return "result has no usage object";
  const u = usage as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    if (!count(u[field]))
      return `usage.${field} is ${String(u[field])}, not a non-negative integer`;
  }
  if (u.outputImages !== undefined && !count(u.outputImages)) {
    return `usage.outputImages is ${String(u.outputImages)}, not a non-negative integer`;
  }
  return null;
}

/**
 * Chooses an output size: an exact `size` must be one the model offers; an `aspectRatio` picks the
 * closest declared ratio (ties by area closest to the default's, then declaration order); neither
 * gives the default size.
 */
export function pickImageSize(
  info: ModelImageGenerationInfo,
  opts: { size?: ImageSize; aspectRatio?: ImageAspectRatio },
): { ok: true; size: ImageSize } | { ok: false; error: string } {
  const fmt = (s: ImageSize) => `${s.width}x${s.height}`;
  const { size, aspectRatio } = opts;
  if (size) {
    const hit = info.sizes.find((s) => s.width === size.width && s.height === size.height);
    if (hit) return { ok: true, size: hit };
    return {
      ok: false,
      error: `Size ${fmt(size)} is not offered by this model; use one of ${info.sizes.map(fmt).join(", ")}.`,
    };
  }
  if (!aspectRatio) return { ok: true, size: info.defaultSize };
  const [rw, rh] = aspectRatio.split(":").map(Number) as [number, number];
  const target = Math.log(rw / rh);
  const area = info.defaultSize.width * info.defaultSize.height;
  let best = info.defaultSize;
  let bestDiff = Number.POSITIVE_INFINITY;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const s of info.sizes) {
    const diff = Math.abs(Math.log(s.width / s.height) - target);
    const areaDiff = Math.abs(s.width * s.height - area);
    if (diff < bestDiff - 1e-9 || (Math.abs(diff - bestDiff) <= 1e-9 && areaDiff < bestArea)) {
      best = s;
      bestDiff = diff;
      bestArea = areaDiff;
    }
  }
  return { ok: true, size: best };
}

/** The `model-provider@2` implementation. */
export interface ModelProvider {
  /**
   * Every model's `parameters` must pass `assertValidDeclarations`, otherwise the kernel does not
   * use this vendor.
   */
  listModels(opts?: ModelCallOptions): Promise<ModelInfo[]>;
  /** The event sequence must end with exactly one message_complete; throw ModelError on error. */
  stream(
    req: ModelRequest,
    opts: { signal: AbortSignal } & ModelCallOptions,
  ): AsyncIterable<ModelStreamEvent>;
  /** Present only on a provider that lists `embedding` models. */
  embed?(req: EmbedRequest, opts: { signal: AbortSignal } & ModelCallOptions): Promise<EmbedResult>;
  /**
   * Present only on a provider that lists `image_generation` models. Throws `ModelError` of kind
   * `refusal` when the vendor declines the prompt.
   */
  generateImage?(
    req: ImageGenerateRequest,
    opts: { signal: AbortSignal } & ModelCallOptions,
  ): Promise<ImageGenerateResult>;
}

/** The model provider extension point (the only version since `@1` was removed before 0.1.0). */
export const MODEL_PROVIDER_EXTENSION_POINT_V2 = "model-provider@2";
