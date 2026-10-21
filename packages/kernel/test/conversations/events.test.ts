import { describe, expect, it } from "vitest";
import { ContentBlockSchema, ConversationEventSchema } from "../../src/conversations/events.js";

describe("ContentBlockSchema", () => {
  it("text 块的 opaque 原样保留（如 OpenAI message 输出项 id，回放时要用）", () => {
    const block = {
      type: "text",
      text: "391",
      opaque: { provider: "openai", model: "gpt-5.5", data: { id: "msg_1" } },
    };
    expect(ContentBlockSchema.parse(block)).toEqual(block);
    expect(ContentBlockSchema.parse({ type: "text", text: "x" })).toEqual({
      type: "text",
      text: "x",
    });
  });

  it("image / document 只认 ref：字节（base64）不进事件日志", () => {
    const ref = { kind: "ref", attachmentId: "3f0c1a52-6b7e-4f43-9a9b-2c1d0e8f7a61" };
    const img = { type: "image", mediaType: "image/png", source: ref, name: "a.png" };
    const pdf = { type: "document", mediaType: "application/pdf", source: ref };
    expect(ContentBlockSchema.parse(img)).toEqual(img);
    expect(ContentBlockSchema.parse(pdf)).toEqual(pdf);
    const b64 = { kind: "base64", data: "AAAA" };
    expect(ContentBlockSchema.safeParse({ ...img, source: b64 }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...pdf, source: b64 }).success).toBe(false);
    expect(
      ContentBlockSchema.safeParse({ ...img, source: { kind: "ref", attachmentId: "" } }).success,
    ).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, mediaType: "image/svg+xml" }).success).toBe(
      false,
    );
    expect(ContentBlockSchema.safeParse({ ...pdf, mediaType: "image/png" }).success).toBe(false);
    // attachmentId 必须是 UUID；name 不超过 255 字符、不含控制字符
    expect(
      ContentBlockSchema.safeParse({ ...img, source: { kind: "ref", attachmentId: "att_1" } })
        .success,
    ).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, name: "a".repeat(255) }).success).toBe(true);
    expect(ContentBlockSchema.safeParse({ ...img, name: "a".repeat(256) }).success).toBe(false);
    expect(ContentBlockSchema.safeParse({ ...img, name: "a\nb" }).success).toBe(false);
    // 整条事件也一样：带 base64 的 user_message 写不进日志
    const ev = (source: unknown) => ({
      type: "user_message",
      payload: {
        content: [
          { type: "text", text: "see" },
          { ...img, source },
        ],
        authorAccountId: "acc-1",
      },
    });
    expect(ConversationEventSchema.safeParse(ev(ref)).success).toBe(true);
    expect(ConversationEventSchema.safeParse(ev(b64)).success).toBe(false);
  });
});

describe("media_excluded 与 model_call.request.media（Ruling M8）", () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const excluded = (attachmentIds: string[], reason = "provider_rejected") =>
    ConversationEventSchema.safeParse({
      type: "media_excluded",
      payload: { attachmentIds, reason },
    }).success;

  it("media_excluded：UUID、1..50 个、原因只有 provider_rejected", () => {
    expect(excluded([uuid(1)])).toBe(true);
    expect(excluded(Array.from({ length: 50 }, (_, i) => uuid(i)))).toBe(true);
    expect(excluded(Array.from({ length: 51 }, (_, i) => uuid(i)))).toBe(false);
    expect(excluded([])).toBe(false);
    expect(excluded(["att_1"])).toBe(false);
    expect(excluded([uuid(1)], "other")).toBe(false);
  });

  it("model_call.request.media：可选；outcome 限定取值，etag 可选", () => {
    const call = (media?: unknown) =>
      ConversationEventSchema.safeParse({
        type: "model_call",
        payload: {
          step: 1,
          attempt: 1,
          provider: "p",
          model: "m",
          fallback: false,
          request: {
            fromSeq: 1,
            toSeq: 2,
            summarySeq: null,
            systemHash: "h",
            reminderSeqs: [],
            ...(media !== undefined && { media }),
          },
        },
      }).success;
    expect(call()).toBe(true);
    expect(
      call([
        { attachmentId: uuid(1), outcome: "bytes", etag: "abc" },
        { attachmentId: uuid(2), outcome: "too_many_pages" },
      ]),
    ).toBe(true);
    expect(call([{ attachmentId: uuid(1), outcome: "sent" }])).toBe(false);
    expect(call([{ attachmentId: "x", outcome: "bytes" }])).toBe(false);
  });
});
