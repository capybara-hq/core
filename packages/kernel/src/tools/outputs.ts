import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/** 文本行数（按 `\n` 切分；空串算 1 行，与按行分页读取一致）。 */
export function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

export interface SavedOutput {
  id: string;
  sizeChars: number;
  lineCount: number;
}

/** 读存档的范围：只能读产生它的那个会话（且组织一致）的存档。 */
export interface OutputScope {
  orgId: string;
  conversationId: string;
}

/**
 * 输出存档（spec 5.4）：超大工具结果的全文存进 `capybara.tool_outputs`，保留 `tools.outputRetentionDays` 天。
 * 只能在产生它的会话里读取（同组织别的会话也不行：会话之间可见范围不同），过期即视为不存在（清理由维护任务负责）。
 */
export class ToolOutputs {
  constructor(
    private readonly db: KernelSchemaDb,
    private readonly config: () => KernelConfig,
  ) {}

  async save(a: {
    orgId: string;
    conversationId: string;
    callId: string;
    content: string;
  }): Promise<SavedOutput> {
    const id = randomUUID();
    const sizeChars = a.content.length;
    const lineCount = countLines(a.content);
    const days = this.config().tools.outputRetentionDays;
    await this.db
      .insertInto("tool_outputs")
      .values({
        id,
        org_id: a.orgId,
        conversation_id: a.conversationId,
        call_id: a.callId,
        size_chars: sizeChars,
        line_count: lineCount,
        content: a.content,
        expires_at: sql<Date>`now() + make_interval(days => ${days})`,
      })
      .execute();
    return { id, sizeChars, lineCount };
  }

  /** 读本会话未过期的存档全文；不存在 / 过期 / 属于别的会话或组织 → null。 */
  async load(scope: OutputScope, id: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("tool_outputs")
      .select("content")
      .where("id", "=", id)
      .where("org_id", "=", scope.orgId)
      .where("conversation_id", "=", scope.conversationId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return row?.content ?? null;
  }
}

/** 存档不存在 / 过期 / 不属于本会话（模型可见，英文；不区分几种情况，不泄露别处的存档是否存在）。 */
export const outputNotFoundText = (id: string): string =>
  `Output ${id} not found or expired. Run the tool that produced it again to get a new output id.`;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 管线第 1 阶段：把参数中任意位置的 `{"$output": "<id>"}`（对象恰好只有这一个键）替换为该存档全文。
 * 不存在 / 过期 / 不属于本会话 → `ToolError`（给模型看的英文）。不修改传入的对象。
 */
export async function resolveOutputRefs(
  input: unknown,
  load: (id: string) => Promise<string | null>,
): Promise<unknown> {
  const cache = new Map<string, string>();
  const walk = async (v: unknown): Promise<unknown> => {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x));
      return out;
    }
    if (!isPlainObject(v)) return v;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$output") {
      const id = v.$output;
      if (typeof id !== "string") {
        throw new ToolError('Invalid {"$output": ...} reference: the output id must be a string.');
      }
      let text = cache.get(id);
      if (text === undefined) {
        const loaded = await load(id);
        if (loaded === null) throw new ToolError(outputNotFoundText(id));
        text = loaded;
        cache.set(id, text);
      }
      return text;
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = await walk(v[k]);
    return out;
  };
  return walk(input);
}

/** base64 数据解码后的字节数。 */
function base64Bytes(data: string): number {
  const s = data.replace(/\s/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

export interface RenderedResult {
  /** 模型看到的文本（尚未转存）。 */
  text: string;
  /** 结果里出现的内容类型（按首次出现的顺序）。 */
  contentTypes: string[];
  isError: boolean;
}

/** 空结果的文本（模型可见，英文；部分供应商不接受空的 tool_result）。 */
const NO_OUTPUT = "(no output)";

/**
 * 管线第 5 阶段（渲染）：文本块按行拼接；图片 → `[image <mimeType>, <n> bytes]`（M3 不把图片回传模型）；
 * `resource_link` → `[resource <uri>]`；未知块 → `[unsupported content <type>]`。
 * 畸形结果（不是对象、content 不是数组）给出说明并标为错误，不抛错（Review Focus 5）。
 */
export function renderResult(result: unknown): RenderedResult {
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return {
      text: "The tool returned a malformed result (expected an object with a content array).",
      contentTypes: [],
      isError: true,
    };
  }
  const parts: string[] = [];
  const types: string[] = [];
  for (const block of result.content as unknown[]) {
    const b = isPlainObject(block) ? block : {};
    const type = typeof b.type === "string" ? b.type : "unknown";
    if (!types.includes(type)) types.push(type);
    if (type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (type === "image" && typeof b.data === "string") {
      const mime = typeof b.mimeType === "string" ? b.mimeType : "unknown";
      parts.push(`[image ${mime}, ${base64Bytes(b.data)} bytes]`);
    } else if (type === "resource_link" && typeof b.uri === "string") {
      parts.push(`[resource ${b.uri}]`);
    } else parts.push(`[unsupported content ${type}]`);
  }
  return {
    text: parts.length === 0 ? NO_OUTPUT : parts.join("\n"),
    contentTypes: types,
    isError: result.isError === true,
  };
}

/**
 * 管线第 5 阶段（转存）：超过 `spillChars` 的文本存为输出存档，模型只见前 `previewChars` 个字符与截断说明。
 */
export async function spillIfLarge(
  text: string,
  opts: { spillChars: number; previewChars: number },
  save: (content: string) => Promise<SavedOutput>,
): Promise<{ content: string; outputId?: string }> {
  if (text.length <= opts.spillChars) return { content: text };
  const saved = await save(text);
  const id = saved.id;
  return {
    content:
      `${text.slice(0, opts.previewChars)}\n…\n` +
      `[Output truncated: ${saved.sizeChars} chars, ${saved.lineCount} lines. Full output id: ${id}. ` +
      `Use read_tool_output to page through it, or pass {"$output":"${id}"} as a tool argument.]`,
    outputId: id,
  };
}
