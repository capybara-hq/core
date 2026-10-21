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
