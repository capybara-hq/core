import type { ContentBlock, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";

/** 一张图片的估算 token 数（固定值，与尺寸无关）。 */
export const IMAGE_TOKENS = 1600;
/** PDF 每页的估算 token 数。 */
export const PDF_PAGE_TOKENS = 1000;
/** 拿不到 PDF 页数（或引用未解析）时按「字节数 ÷ 3」估算。 */
const BYTES_PER_TOKEN = 3;
/** 未解析的文档引用（不应出现在发出的请求里）的保守估算。 */
const UNRESOLVED_DOCUMENT_TOKENS = 1000;

/** base64 解码后的字节数（按长度计算，不解码）。 */
function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length / 4) * 3) - pad);
}

/**
 * PDF 的页数：数未压缩的页对象（`/Type /Page`，不含 `/Pages`）。页对象放在压缩的对象流里时数不到，返回 0。
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

/** 媒体块的估算：图片固定 {@link IMAGE_TOKENS}；PDF 页数 × {@link PDF_PAGE_TOKENS}（数不到按字节 ÷ 3）；文本文档按字节 ÷ 3。 */
function mediaTokens(b: Extract<ContentBlock, { type: "image" | "document" }>): number {
  if (b.type === "image") return IMAGE_TOKENS;
  if (b.source.kind !== "base64") return UNRESOLVED_DOCUMENT_TOKENS;
  const size = base64Bytes(b.source.data);
  if (b.mediaType === "application/pdf") {
    const pages = countPdfPages(Buffer.from(b.source.data, "base64"));
    if (pages > 0) return pages * PDF_PAGE_TOKENS;
  }
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
 * 媒体块：图片固定 1600；PDF 按页数 × 1000（数不到页数时按字节 ÷ 3）；其他文档按字节 ÷ 3。
 */
export function estimateTokens(
  messages: ModelMessage[],
  system: ModelRequest["system"],
  tools: ModelRequest["tools"] = [],
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
          media += mediaTokens(b);
          break;
      }
    }
  }
  return c.tokens() + media;
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
