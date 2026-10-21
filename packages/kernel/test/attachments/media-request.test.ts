import { randomUUID } from "node:crypto";
import type { ModelInfo, ModelMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { LogContentBlock } from "../../src/conversations/events.js";
import {
  buildModelRequest,
  type MediaBytes,
  mediaRefsNeeded,
  TEXT_INLINE_MAX_CHARS,
} from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import { AGENT, Log, MODEL } from "../runtime/context/fixtures.js";

const SEE: ModelInfo = {
  ...MODEL,
  capabilities: { ...MODEL.capabilities, vision: true, documents: true },
};
const BLIND: ModelInfo = {
  ...MODEL,
  capabilities: { ...MODEL.capabilities, vision: false, documents: false },
};
const VISION_ONLY: ModelInfo = {
  ...MODEL,
  capabilities: { ...MODEL.capabilities, vision: true },
};

const IMG = randomUUID();
const PDF = randomUUID();
const TXT = randomUUID();
const GONE = randomUUID();

const bytes = (s: string) => new TextEncoder().encode(s);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PDF_BYTES = bytes("%PDF-1.4\n<< /Type /Page >>\n<< /Type /Page >>\n<< /Type /Pages >>");

const ref = (attachmentId: string) => ({ kind: "ref" as const, attachmentId });
const content: LogContentBlock[] = [
  { type: "text", text: "see these" },
  { type: "image", mediaType: "image/png", source: ref(IMG), name: "cat.png" },
  { type: "document", mediaType: "application/pdf", source: ref(PDF), name: "spec.pdf" },
  { type: "document", mediaType: "text/plain", source: ref(TXT), name: "notes.txt" },
];

function logWith(blocks: LogContentBlock[]): Log {
  const log = new Log();
  log.add({ type: "user_message", payload: { content: blocks, authorAccountId: "acc-1" } }, null);
  return log;
}

const media = (extra: [string, MediaBytes | null][] = []) =>
  new Map<string, MediaBytes | null>([
    [IMG, { mediaType: "image/png", data: PNG_BYTES }],
    [PDF, { mediaType: "application/pdf", data: PDF_BYTES }],
    [TXT, { mediaType: "text/plain", data: bytes("hello notes") }],
    ...extra,
  ]);

const userContent = (messages: ModelMessage[]) =>
  messages.flatMap((m) => (m.role === "user" ? m.content : []));

const build = (model: ModelInfo, log: Log, m = media()) =>
  buildModelRequest({
    events: log.events,
    agent: AGENT,
    agentVersion: 1,
    model,
    step: 0,
    media: m,
  });

describe("buildModelRequest 解析媒体引用", () => {
  it("模型支持：ref 换成 base64（图片看 vision，PDF 与文本看 documents）", () => {
    const { request } = build(SEE, logWith(content));
    expect(userContent(request.messages)).toEqual([
      { type: "text", text: "see these" },
      {
        type: "image",
        mediaType: "image/png",
        name: "cat.png",
        source: { kind: "base64", data: Buffer.from(PNG_BYTES).toString("base64") },
      },
      {
        type: "document",
        mediaType: "application/pdf",
        name: "spec.pdf",
        source: { kind: "base64", data: Buffer.from(PDF_BYTES).toString("base64") },
      },
      {
        type: "document",
        mediaType: "text/plain",
        name: "notes.txt",
        source: { kind: "base64", data: Buffer.from("hello notes").toString("base64") },
      },
    ]);
  });

  it("模型不支持：只有文字占位，绝不带字节；文本文件内联", () => {
    const { request } = build(BLIND, logWith(content));
    const blocks = userContent(request.messages);
    expect(blocks).toEqual([
      { type: "text", text: "see these" },
      { type: "text", text: '[Attached image "cat.png" — this model cannot view images.]' },
      {
        type: "text",
        text: '[Attached document "spec.pdf" — this model cannot read PDF documents.]',
      },
      { type: "text", text: '[Attached file "notes.txt" (text/plain)]\nhello notes' },
    ]);
    const sent = JSON.stringify(request);
    expect(sent).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));
    expect(sent).not.toContain(Buffer.from(PDF_BYTES).toString("base64"));
  });

  it("只支持图片的模型：图片是 base64，PDF 是占位", () => {
    const { request } = build(VISION_ONLY, logWith(content));
    const types = userContent(request.messages).map((b) => b.type);
    expect(types).toEqual(["text", "image", "text", "text"]);
  });

  it("字节缺失（未取到或已删除）→「不再可用」占位；没有名字时用 attachment", () => {
    const log = logWith([
      { type: "image", mediaType: "image/png", source: ref(GONE), name: "gone.png" },
      { type: "document", mediaType: "text/csv", source: ref(randomUUID()) },
    ]);
    const { request } = build(SEE, log, media([[GONE, null]]));
    expect(userContent(request.messages)).toEqual([
      { type: "text", text: '[Attachment "gone.png" is no longer available.]' },
      { type: "text", text: '[Attachment "attachment" is no longer available.]' },
    ]);
  });

  it("文本内联超过上限时截断并注明", () => {
    const long = "x".repeat(TEXT_INLINE_MAX_CHARS + 10);
    const { request } = build(
      BLIND,
      logWith([content[3] as LogContentBlock]),
      media([[TXT, { mediaType: "text/plain", data: bytes(long) }]]),
    );
    const [b] = userContent(request.messages);
    expect(b?.type).toBe("text");
    const text = b?.type === "text" ? b.text : "";
    expect(text).toContain("x".repeat(TEXT_INLINE_MAX_CHARS));
    expect(text).not.toContain("x".repeat(TEXT_INLINE_MAX_CHARS + 1));
    expect(text).toContain(`first ${TEXT_INLINE_MAX_CHARS} of ${TEXT_INLINE_MAX_CHARS + 10}`);
  });

  it("超过 MEDIA_LIMITS 的图片不发字节，换成占位", () => {
    const big = new Uint8Array(5_242_881);
    const { request } = build(
      SEE,
      logWith([content[1] as LogContentBlock]),
      media([[IMG, { mediaType: "image/png", data: big }]]),
    );
    const [b] = userContent(request.messages);
    expect(b?.type).toBe("text");
  });

  it("不改写日志：同一事件构建两次结果相同，日志里仍是 ref", () => {
    const log = logWith(content);
    const a = build(SEE, log);
    const b = build(SEE, log);
    expect(a.request).toEqual(b.request);
    expect(JSON.stringify(log.events)).not.toContain("base64");
  });
});

describe("mediaRefsNeeded", () => {
  it("只列出该模型会用到字节的引用（不支持的不取）", () => {
    const log = logWith(content);
    expect(mediaRefsNeeded(log.events, SEE).sort()).toEqual([IMG, PDF, TXT].sort());
    // 不支持时：图片、PDF 不取字节，文本仍要内联
    expect(mediaRefsNeeded(log.events, BLIND)).toEqual([TXT]);
    expect(mediaRefsNeeded(log.events, VISION_ONLY).sort()).toEqual([IMG, TXT].sort());
  });
});

describe("token 估算", () => {
  it("图片按 1600、PDF 按页数 × 1000、拿不到页数时按字节 / 3", () => {
    const img: ModelMessage = {
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", source: { kind: "base64", data: "iVBO" } },
      ],
    };
    expect(estimateTokens([img], [])).toBe(1600);
    const pdf: ModelMessage = {
      role: "user",
      content: [
        {
          type: "document",
          mediaType: "application/pdf",
          source: { kind: "base64", data: Buffer.from(PDF_BYTES).toString("base64") },
        },
      ],
    };
    expect(estimateTokens([pdf], [])).toBe(2000);
    const opaque = new Uint8Array(3000).fill(0x41);
    const noPages: ModelMessage = {
      role: "user",
      content: [
        {
          type: "document",
          mediaType: "application/pdf",
          source: { kind: "base64", data: Buffer.from(opaque).toString("base64") },
        },
      ],
    };
    expect(estimateTokens([noPages], [])).toBe(1000);
  });
});

describe("压缩记录", () => {
  it("媒体块记为 [image: name] / [document: name]", () => {
    const log = logWith(content);
    log.assistant("ok");
    log.user("next");
    const plan = compactionPlan(log.events, 1);
    expect(plan?.transcript).toContain("[image: cat.png]");
    expect(plan?.transcript).toContain("[document: spec.pdf]");
    expect(plan?.transcript).toContain("[document: notes.txt]");
  });
});
