import type { ContentBlock, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import { IMAGE_TOKENS, pdfTokens } from "./build.js";

/** 文档按「字节数 ÷ 3」估算。 */
const BYTES_PER_TOKEN = 3;
/** 未解析的文档引用（不应出现在发出的请求里）的保守估算。 */
const UNRESOLVED_DOCUMENT_TOKENS = 1000;

/** base64 解码后的字节数（按长度计算，不解码）。 */
function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length / 4) * 3) - pad);
}

/**
 * 媒体块的兜底估算（没有构建时算好的 `mediaTokens` 时用，不解码）：图片固定 1600；PDF 按大小换算页数
 * （见 `pdfTokens`，绝不按字节 ÷ 3）；其他文档按字节 ÷ 3。
 */
function blockMediaTokens(b: Extract<ContentBlock, { type: "image" | "document" }>): number {
  if (b.type === "image") return IMAGE_TOKENS;
  if (b.source.kind !== "base64") return UNRESOLVED_DOCUMENT_TOKENS;
  const size = base64Bytes(b.source.data);
  if (b.mediaType === "application/pdf") return pdfTokens(size, null);
  return Math.ceil(size / BYTES_PER_TOKEN);
}

/** 校正比例的上下限：单轮真实值偏差再大，也不让估算失控。 */
const MIN_RATIO = 0.5;
const MAX_RATIO = 3;

/** 逐个 UTF-16 码元计数：ASCII 与非 ASCII 分开累加。线性扫描，不做分词。 */
class CharCounter {
  ascii = 0;
  other = 0;

  add(text: string): void {
    let ascii = 0;
    const len = text.length;
    for (let i = 0; i < len; i++) {
      if (text.charCodeAt(i) < 128) ascii++;
    }
    this.ascii += ascii;
    this.other += len - ascii;
  }

  tokens(): number {
    return Math.ceil(this.ascii / 4 + this.other);
  }
}

/**
 * 估算请求的输入 token 数：ASCII 字符数 ÷ 4 + 非 ASCII 字符数 × 1，向上取整。
 * 故意不用 BPE 分词器：长段中文分词会阻塞事件循环（可靠性清单 A）；偏差由 `calibrate` 按真实用量校正。
 * 工具定义（名字、描述、inputSchema 的 JSON）计入。供应商私有数据（opaque）大小未知，不计入。
 * 媒体块：传了 `mediaTokens`（`buildModelRequest` 按行信息算好的：图片 1600、PDF 页数 × 1000 等）时
 * 直接用它、不再逐块估算；否则按块兜底（图片 1600，文档按字节 ÷ 3，不解码）。
 */
export function estimateTokens(
  messages: ModelMessage[],
  system: ModelRequest["system"],
  tools: ModelRequest["tools"] = [],
  mediaTokens?: number,
): number {
  const c = new CharCounter();
  let media = 0;
  for (const s of system) c.add(s.text);
  for (const t of tools) {
    c.add(t.name);
    c.add(t.description);
    c.add(JSON.stringify(t.inputSchema) ?? "");
  }
  for (const m of messages) {
    if (m.role === "system") {
      c.add(m.content);
      continue;
    }
    for (const b of m.content) {
      switch (b.type) {
        case "text":
        case "thinking":
          c.add(b.text);
          break;
        case "tool_call":
          c.add(b.name);
          c.add(JSON.stringify(b.input) ?? "");
          break;
        case "tool_result":
          c.add(b.content);
          break;
        case "image":
        case "document":
          if (mediaTokens === undefined) media += blockMediaTokens(b);
          break;
      }
    }
  }
  return c.tokens() + (mediaTokens ?? media);
}

/**
 * 用上一轮的真实输入 token 数校正估算：乘以 `inputTokens / estimate`，比例夹在 0.5–3。
 * 没有上一轮（或上一轮估算为 0）时原样返回。
 */
export function calibrate(
  estimate: number,
  lastActual: { estimate: number; inputTokens: number } | null,
): number {
  if (!lastActual || lastActual.estimate <= 0) return estimate;
  const ratio = Math.min(
    MAX_RATIO,
    Math.max(MIN_RATIO, lastActual.inputTokens / lastActual.estimate),
  );
  return Math.ceil(estimate * ratio);
}
