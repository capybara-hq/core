import { createHash } from "node:crypto";
import {
  type ContentBlock,
  ModelError,
  type ModelErrorKind,
  type ModelInfo,
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
}

const CACHE_TTL_SECONDS = 300;
const CHUNK_CHARS = 4;
/** 多块输出时块间默认间隔，保证调用方能在流进行中中止。 */
const DEFAULT_CHUNK_DELAY_MS = 2;
const COMPACTION_MARKER = "CAPYBARA_COMPACTION";
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
      else n += b.name.length + JSON.stringify(b.input ?? null).length;
    }
  }
  return n;
}

/** 最后一条 user 消息：文本，以及它是否带 tool_result。 */
function lastUser(req: ModelRequest): { text: string; hasToolResult: boolean; result: string } {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    let text = "";
    let result = "";
    let hasToolResult = false;
    for (const b of m.content) {
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
  | { kind: "text"; text: string; chunk: number; delayMs: number }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "stall" }
  | { kind: "fail"; error: ModelError };

function plan(req: ModelRequest): Plan {
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
  const slow = /^slow:(\d+):([\s\S]*)$/.exec(text);
  if (slow) {
    return { kind: "text", text: slow[2] as string, chunk: CHUNK_CHARS, delayMs: Number(slow[1]) };
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
  // 请求带了工具、且不是脚本指令：调用第一个工具（参数为空对象），让一致性套件能走通工具往返。
  const first = req.tools[0];
  if (first !== undefined) return { kind: "tool", name: first.name, input: {} };
  return std(`You said: ${text}`);
}

export interface FakeProviderOptions {
  kv: Kv;
  models?: readonly FakeModelConfig[];
  /** 测试注入；默认用可中止的 node:timers/promises 等待（单次请求内的本地等待，不是共享状态）。 */
  sleep?: Sleep;
}

export function createFakeProvider(opts: FakeProviderOptions): ModelProvider {
  const sleep = opts.sleep ?? defaultSleep;
  const configured =
    opts.models !== undefined && opts.models.length > 0 ? opts.models : [{ id: "fake-1" }];
  const infos: ModelInfo[] = configured.map((m) => ({
    id: m.id,
    displayName: m.id,
    contextWindow: m.contextWindow ?? 32000,
    maxOutputTokens: 4096,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: false,
      caching: true,
      midConversationSystem: true,
      effort: false,
    },
    ...(m.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: m.streamIdleTimeoutMs } : {}),
  }));

  /** 系统前缀第二次出现时返回命中的字符数；命中记录在 kv，TTL 300 秒。 */
  async function cacheUsage(req: ModelRequest): Promise<{ read: number; write: number }> {
    const prefix = req.system
      .filter((s) => s.cache)
      .map((s) => s.text)
      .join("\n");
    if (prefix === "") return { read: 0, write: 0 };
    const key = `model-fake:prefix:${createHash("sha256").update(prefix).digest("hex")}`;
    const chars = prefix.length;
    if ((await opts.kv.get(key)) !== null) return { read: tokens(chars), write: 0 };
    await opts.kv.set(key, String(chars), { ttlSeconds: CACHE_TTL_SECONDS });
    return { read: 0, write: tokens(chars) };
  }

  return {
    async listModels() {
      return infos.map((i) => structuredClone(i));
    },

    async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
      if (!infos.some((i) => i.id === req.model)) {
        throw new ModelError("invalid_request", `Unknown model "${req.model}"`);
      }
      if (signal.aborted) throw abortError();
      const p = plan(req);
      if (p.kind === "fail") throw p.error;
      if (p.kind === "stall") return await waitForAbort(signal);

      const cache = await cacheUsage(req);
      const usage = (outChars: number) => ({
        inputTokens: tokens(inputChars(req)),
        outputTokens: tokens(outChars),
        cacheReadTokens: cache.read,
        cacheWriteTokens: cache.write,
      });

      if (p.kind === "tool") {
        const id = `call_${createHash("sha256")
          .update(`${req.messages.length}:${p.name}:${JSON.stringify(p.input)}`)
          .digest("hex")
          .slice(0, 12)}`;
        const content: ContentBlock[] = [{ type: "tool_call", id, name: p.name, input: p.input }];
        yield {
          type: "message_complete",
          content,
          stopReason: "tool_use",
          usage: usage(p.name.length + JSON.stringify(p.input ?? null).length),
        };
        return;
      }

      let text = p.text;
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
