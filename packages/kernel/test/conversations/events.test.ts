import { describe, expect, it } from "vitest";
import { ContentBlockSchema } from "../../src/conversations/events.js";

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
});
