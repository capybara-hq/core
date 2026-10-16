import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/index.js";

describe("plugin-sdk", () => {
  it("导出语义化版本号", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
