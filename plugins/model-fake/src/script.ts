import { createHash } from "node:crypto";
import {
  type ContentBlock,
  type ModelCallOptions,
  ModelError,
  type ModelErrorKind,
  type ModelInfo,
  type ModelKind,
  type ModelParameter,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
} from "@capybara-hq/plugin-sdk";

/** 插件用到的 ctx.kv 子集。 */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
}

/** 可被 signal 中止的等待；中止时 reject。 */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface FakeModelConfig {
  id: string;
  contextWindow?: number | undefined;
  streamIdleTimeoutMs?: number | undefined;
  /** 声明支持图片输入（默认 false：内核把图片换成文字占位）。 */
  vision?: boolean | undefined;
  /** 声明支持文档输入（默认 false）。 */
  documents?: boolean | undefined;
  /** What the model does (default chat). */
  kind?: ModelKind | undefined;
  publisher?: string | undefined;
  /** Embedding output dimensions (default [8, 16]); the first is the default. */
  dimensions?: number[] | undefined;
  /** Most inputs per embed call (default 4). */
  maxBatch?: number | undefined;
}

const CACHE_TTL_SECONDS = 300;
const CHUNK_CHARS = 4;
/** 多块输出时块间默认间隔，保证调用方能在流进行中中止。 */
const DEFAULT_CHUNK_DELAY_MS = 2;
const COMPACTION_MARKER = "CAPYBARA_COMPACTION";

/**
 * 每个模型声明的参数：三档 effort（只记录、不影响输出）与厂商专有参数 `model-fake.style`
 * （`shout` 时回复转大写），供测试与演示界面使用。都不给默认值：未设置时不进请求参数。
 */
const parameters = (): ModelParameter[] => [
  {
    key: "effort",
    standard: "effort",
    schema: { type: "string", enum: ["low", "medium", "high"] },
    label: { zh: "思考深度", en: "Effort" },
    description: {
      zh: "假模型只记录该值，不影响输出",
      en: "Recorded only; the fake model's output does not change",
    },
  },
  {
    key: "model-fake.style",
    schema: { type: "string", enum: ["plain", "shout"] },
    label: { zh: "回复风格", en: "Reply style" },
    description: { zh: "shout 时回复全部转大写", en: "shout upper-cases the whole reply" },
  },
];
function isErrorKind(kind: string): kind is ModelErrorKind {
  const kinds: readonly ModelErrorKind[] = [
    "rate_limited",
    "overloaded",
    "server",
    "timeout",
    "network",
    "auth",
    "invalid_request",
    "context_overflow",
    "aborted",
  ];
  return (kinds as readonly string[]).includes(kind);
}

/** 用 AbortSignal.timeout 做单次请求内的本地等待：到点或被调用方中止即返回，中止时抛 aborted。 */
const defaultSleep: Sleep = async (ms, signal) => {
  const timeout = AbortSignal.timeout(ms);
  await new Promise<void>((resolve) => {
    if (signal.aborted || timeout.aborted) return resolve();
    const done = () => {
      signal.removeEventListener("abort", done);
      timeout.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done);
    timeout.addEventListener("abort", done);
  });
  if (signal.aborted) throw new ModelError("aborted", "Request aborted");
};

const tokens = (chars: number): number => Math.ceil(chars / 4);

function abortError(): ModelError {
  return new ModelError("aborted", "Request aborted");
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function inputChars(req: ModelRequest): number {
  let n = 0;
  for (const s of req.system) n += s.text.length;
  for (const m of req.messages) {
    if (m.role === "system") {
      n += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text" || b.type === "thinking") n += b.text.length;
      else if (b.type === "tool_result") n += b.content.length;
      else if (b.type === "tool_call") n += b.name.length + JSON.stringify(b.input ?? null).length;
      // image / document 不计入（媒体映射见 M5 T4）
    }
  }
  return n;
}

/** 最后一条 user 消息里的媒体块：`<类型> <mediaType> <解码后字节数> bytes[ <name>]`，以 `; ` 连接。 */
function mediaSummary(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type !== "image" && b.type !== "document") continue;
      const size =
        b.source.kind === "base64" ? `${Buffer.from(b.source.data, "base64").length} bytes` : "ref";
      parts.push(`${b.type} ${b.mediaType} ${size}${b.name !== undefined ? ` ${b.name}` : ""}`);
    }
    return parts.length > 0 ? parts.join("; ") : "none";
  }
  return "none";
}

/**
 * The kernel's sender line (run context spec §4): a separate first text block `From <name>` or
 * `From <name> (<role>)` before the message's own blocks. Scripts read the message without it.
 */
const SENDER_LINE = /^From [^\n]+$/;

/** 最后一条 user 消息：文本，以及它是否带 tool_result。 */
function lastUser(req: ModelRequest): { text: string; hasToolResult: boolean; result: string } {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    let text = "";
    let result = "";
    let hasToolResult = false;
    const first = m.content[0];
    const blocks =
      m.content.length > 1 && first?.type === "text" && SENDER_LINE.test(first.text)
        ? m.content.slice(1)
        : m.content;
    for (const b of blocks) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_result") {
        hasToolResult = true;
        result += b.content;
      }
    }
    return { text, hasToolResult, result };
  }
  return { text: "", hasToolResult: false, result: "" };
}

type Plan =
  | { kind: "text"; text: string; chunk: number; delayMs: number; failAfter?: ModelError }
  | {
      kind: "tool";
      name: string;
      input: unknown;
      more?: { name: string; input: unknown }[];
      /** `slowtool:`: wait this long before the call (a message can arrive while it streams). */
      delayMs?: number;
    }
  | { kind: "stall" }
  | { kind: "fail"; error: ModelError };

/**
 * `toolChoice: "none"`：不得调用工具——工具调用计划改为说明文本（脚本指令）或按无工具回复（默认的「只有一个工具时调用它」）。
 */
function plan(req: ModelRequest): Plan {
  const p = scripted(req);
  if (p.kind !== "tool" || req.toolChoice !== "none") return p;
  const { text } = lastUser(req);
  const t = text.startsWith("tool:")
    ? `Tool calls are disabled; would call ${p.name}.`
    : `You said: ${text}`;
  return { kind: "text", text: t, chunk: CHUNK_CHARS, delayMs: DEFAULT_CHUNK_DELAY_MS };
}

function scripted(req: ModelRequest): Plan {
  const { text, hasToolResult, result } = lastUser(req);
  const std = (t: string): Plan => ({
    kind: "text",
    text: t,
    chunk: CHUNK_CHARS,
    delayMs: DEFAULT_CHUNK_DELAY_MS,
  });

  if (req.system.some((s) => s.text.includes(COMPACTION_MARKER))) {
    return std(`Summary: ${text.slice(0, 200)}`);
  }
  if (text.startsWith("echo:")) return std(text.slice(5));
  // media:：回显收到的媒体块（类型、mediaType、字节数），供 e2e 核对模型确实收到了字节
  if (text.startsWith("media:")) return std(`Media: ${mediaSummary(req)}`);
  const slow = /^slow:(\d+):([\s\S]*)$/.exec(text);
  if (slow) {
    return { kind: "text", text: slow[2] as string, chunk: CHUNK_CHARS, delayMs: Number(slow[1]) };
  }
  const slowFail = /^slowfail:(\d+):([\s\S]*)$/.exec(text);
  if (slowFail) {
    return {
      kind: "text",
      text: slowFail[2] as string,
      chunk: CHUNK_CHARS,
      delayMs: Number(slowFail[1]),
      failAfter: new ModelError("invalid_request", "Scripted failure after streaming"),
    };
  }
  if (text === "stall") return { kind: "stall" };
  if (text.startsWith("fail:")) {
    const kind = text.slice(5).trim();
    if (!isErrorKind(kind)) {
      return {
        kind: "fail",
        error: new ModelError("invalid_request", `Unknown failure kind "${kind}"`),
      };
    }
    return {
      kind: "fail",
      error: new ModelError(kind, `Scripted ${kind} failure`),
    };
  }
  // `tools:[{"name":…,"input":…},…]`: several calls in one assistant message
  const multi = /^tools:(\[[\s\S]*\])$/.exec(text);
  if (multi) {
    try {
      const calls = JSON.parse(multi[1] as string) as { name: string; input: unknown }[];
      const [first, ...more] = calls;
      if (first === undefined) throw new Error("empty");
      return { kind: "tool", name: first.name, input: first.input, more };
    } catch {
      return {
        kind: "fail",
        error: new ModelError("invalid_request", "tools directive carries invalid JSON"),
      };
    }
  }
  // `slowtool:<ms>:<name>:<json>`: the tool call after a wait (the step is still streaming)
  const slowTool = /^slowtool:(\d+):([^:]+):([\s\S]*)$/.exec(text);
  if (slowTool) {
    try {
      return {
        kind: "tool",
        name: slowTool[2] as string,
        input: JSON.parse(slowTool[3] as string),
        delayMs: Number(slowTool[1]),
      };
    } catch {
      return {
        kind: "fail",
        error: new ModelError("invalid_request", "slowtool directive carries invalid JSON"),
      };
    }
  }
  const tool = /^tool:([^:]+):([\s\S]*)$/.exec(text);
  if (tool) {
    try {
      return { kind: "tool", name: tool[1] as string, input: JSON.parse(tool[2] as string) };
    } catch {
      return {
        kind: "fail",
        error: new ModelError("invalid_request", "tool directive carries invalid JSON"),
      };
    }
  }
  const long = /^long:(\d+)$/.exec(text);
  if (long) {
    const words = Array.from({ length: Number(long[1]) }, (_, i) => `word${i + 1}`);
    return { kind: "text", text: words.join(" "), chunk: 64, delayMs: 0 };
  }
  if (hasToolResult) return std(`Tool result: ${result}`);
  // a request offering exactly one tool, with no script directive: call it with an empty input
  // (the conformance suite's tool round trip). Agents have every tool by default (tools default-on
  // spec), so with several tools an ordinary message gets an ordinary reply.
  const only = req.tools.length === 1 ? req.tools[0] : undefined;
  if (only !== undefined) return { kind: "tool", name: only.name, input: {} };
  return std(`You said: ${text}`);
}

/** A deterministic vector of `dim` values in [-1, 1], seeded by the sha256 of the text. */
function embedVector(text: string, dim: number): number[] {
  const out: number[] = [];
  for (let block = 0; out.length < dim; block++) {
    const h = createHash("sha256").update(`${block}:${text}`).digest();
    for (let i = 0; i + 1 < h.length && out.length < dim; i += 2) {
      out.push((h.readUInt16BE(i) / 65535) * 2 - 1);
    }
  }
  return out;
}

export interface FakeProviderOptions {
  kv: Kv;
  models?: readonly FakeModelConfig[];
  /** Reads the models of a per-call config (`opts.config`); undefined keeps the setup models. */
  modelsOf?: (config: unknown) => readonly FakeModelConfig[] | undefined;
  /** 测试注入；默认用可中止的 node:timers/promises 等待（单次请求内的本地等待，不是共享状态）。 */
  sleep?: Sleep;
}

export function createFakeProvider(opts: FakeProviderOptions): ModelProvider {
  const sleep = opts.sleep ?? defaultSleep;
  const ERROR_KINDS: readonly string[] = [
    "rate_limited",
    "overloaded",
    "server",
    "timeout",
    "network",
    "auth",
    "invalid_request",
    "context_overflow",
    "aborted",
  ] satisfies ModelErrorKind[];
  function infosOf(models: readonly FakeModelConfig[] | undefined): ModelInfo[] {
    const configured = models !== undefined && models.length > 0 ? models : [{ id: "fake-1" }];
    return configured.map((m) => {
      const embedding = m.kind === "embedding";
      const dims = m.dimensions ?? [8, 16];
      return {
        id: m.id,
        displayName: m.id,
        ...(m.kind !== undefined ? { kind: m.kind } : {}),
        ...(m.publisher !== undefined ? { publisher: m.publisher } : {}),
        ...(embedding
          ? {
              embedding: {
                dimensions: dims,
                defaultDimensions: m.dimensions?.[0] ?? 8,
                maxInputTokens: 512,
                maxBatch: m.maxBatch ?? 4,
              },
            }
          : {}),
        contextWindow: m.contextWindow ?? 32000,
        maxOutputTokens: 4096,
        capabilities: {
          tools: true,
          vision: m.vision ?? false,
          documents: m.documents ?? false,
          reasoning: false,
          caching: true,
          midConversationSystem: true,
        },
        ...(m.streamIdleTimeoutMs !== undefined
          ? { streamIdleTimeoutMs: m.streamIdleTimeoutMs }
          : {}),
        parameters: parameters(),
      };
    });
  }
  const setupInfos = infosOf(opts.models);
  /** The models for one call: the per-call config's list when present, else the setup list. */
  function infosFor(call: ModelCallOptions | undefined): ModelInfo[] {
    if (call?.config === undefined || opts.modelsOf === undefined) return setupInfos;
    const models = opts.modelsOf(call.config);
    return models === undefined ? setupInfos : infosOf(models);
  }

  /**
   * 可缓存的系统前缀：首次出现计为缓存写，再次出现计为缓存读（命中记录在 kv，TTL 300 秒）。
   * `cachedChars` 为前缀字符数，从 inputTokens 中扣除（inputTokens 只算未缓存部分）。
   */
  async function cacheUsage(
    req: ModelRequest,
  ): Promise<{ read: number; write: number; cachedChars: number }> {
    const cached = req.system.filter((s) => s.cache).map((s) => s.text);
    const prefix = cached.join("\n");
    if (prefix === "") return { read: 0, write: 0, cachedChars: 0 };
    const key = `model-fake:prefix:${createHash("sha256").update(prefix).digest("hex")}`;
    const cachedChars = cached.reduce((n, t) => n + t.length, 0);
    if ((await opts.kv.get(key)) !== null) {
      return { read: tokens(cachedChars), write: 0, cachedChars };
    }
    await opts.kv.set(key, String(cachedChars), { ttlSeconds: CACHE_TTL_SECONDS });
    return { read: 0, write: tokens(cachedChars), cachedChars };
  }

  return {
    async listModels(call) {
      return infosFor(call).map((i) => structuredClone(i));
    },

    async embed(req, call) {
      if (call.signal.aborted) throw abortError();
      const info = infosFor(call).find((i) => i.id === req.model && i.kind === "embedding");
      if (info?.embedding === undefined) {
        throw new ModelError("invalid_request", `Unknown embedding model "${req.model}"`);
      }
      const failure = /^fail:(\w+)/.exec(req.input[0] ?? "");
      if (failure && ERROR_KINDS.includes(failure[1] as string)) {
        throw new ModelError(failure[1] as ModelErrorKind, `scripted failure: ${failure[1]}`);
      }
      const dim = req.dimensions ?? info.embedding.defaultDimensions;
      if (!info.embedding.dimensions.includes(dim)) {
        throw new ModelError("invalid_request", `Unsupported dimensions ${dim}`);
      }
      if (req.input.length > info.embedding.maxBatch) {
        throw new ModelError("invalid_request", "Too many inputs in one embed call");
      }
      return {
        vectors: req.input.map((t) => embedVector(t, dim)),
        usage: { inputTokens: req.input.reduce((n, t) => n + Math.ceil(t.length / 4), 0) },
      };
    },

    async *stream(req, call): AsyncGenerator<ModelStreamEvent> {
      const { signal } = call;
      if (!infosFor(call).some((i) => i.id === req.model && (i.kind ?? "chat") === "chat")) {
        throw new ModelError("invalid_request", `Unknown model "${req.model}"`);
      }
      if (signal.aborted) throw abortError();
      const p = plan(req);
      if (p.kind === "fail") throw p.error;
      if (p.kind === "stall") return await waitForAbort(signal);

      const cache = await cacheUsage(req);
      const usage = (outChars: number) => ({
        inputTokens: tokens(inputChars(req) - cache.cachedChars),
        outputTokens: tokens(outChars),
        cacheReadTokens: cache.read,
        cacheWriteTokens: cache.write,
      });

      if (p.kind === "tool") {
        if (p.delayMs !== undefined && p.delayMs > 0) await sleep(p.delayMs, signal);
        const calls = [{ name: p.name, input: p.input }, ...(p.more ?? [])];
        const content: ContentBlock[] = calls.map((c, i) => ({
          type: "tool_call",
          id: `call_${createHash("sha256")
            .update(
              `${req.messages.length}:${i === 0 ? "" : `${i}:`}${c.name}:${JSON.stringify(c.input)}`,
            )
            .digest("hex")
            .slice(0, 12)}`,
          name: c.name,
          input: c.input,
        }));
        yield {
          type: "message_complete",
          content,
          stopReason: "tool_use",
          usage: usage(
            calls.reduce((n, c) => n + c.name.length + JSON.stringify(c.input ?? null).length, 0),
          ),
        };
        return;
      }

      let text = req.params["model-fake.style"] === "shout" ? p.text.toUpperCase() : p.text;
      let stopReason: StopReason = "end_turn";
      if (text.length > req.maxOutputTokens * 4) {
        text = text.slice(0, req.maxOutputTokens * 4);
        stopReason = "max_tokens";
      }
      for (let i = 0; i < text.length; i += p.chunk) {
        if (i > 0 && p.delayMs > 0) await sleep(p.delayMs, signal);
        if (signal.aborted) throw abortError();
        yield { type: "text_delta", text: text.slice(i, i + p.chunk) };
      }
      if (p.failAfter) {
        // slowfail：输出完文本后再停一下，然后失败（不产生 message_complete）
        if (p.delayMs > 0) await sleep(p.delayMs, signal);
        throw p.failAfter;
      }
      if (signal.aborted) throw abortError();
      yield {
        type: "message_complete",
        content: text === "" ? [] : [{ type: "text", text }],
        stopReason,
        usage: usage(text.length),
      };
    },
  };
}
