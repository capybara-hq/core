import { describe, expect, it } from "vitest";
import { extensionLabel, modelLabel } from "../src/lib/extension-label";

const compat = {
  name: "openai-compatible",
  displayName: { zh: "OpenAI 兼容", en: "OpenAI compatible" },
};

describe("extensionLabel", () => {
  it("uses the display name in the page locale", () => {
    expect(extensionLabel(compat, "zh")).toBe("OpenAI 兼容");
    expect(extensionLabel(compat, "en")).toBe("OpenAI compatible");
  });
  it("falls back to the id without a display name", () => {
    expect(extensionLabel({ name: "todo", displayName: null }, "zh")).toBe("todo");
    expect(extensionLabel({ name: "todo" }, "en")).toBe("todo");
  });
});

describe("modelLabel", () => {
  it("reads provider display name / model", () => {
    expect(modelLabel(compat, "deepseek/deepseek-flash", "zh")).toBe(
      "OpenAI 兼容 / deepseek/deepseek-flash",
    );
  });
  it("falls back to the provider id", () => {
    expect(modelLabel({ name: "x" }, "m", "en")).toBe("x / m");
  });
});
