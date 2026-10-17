import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { normalizeLogin, validatePassword } from "../../src/identity/login.js";

describe("normalizeLogin", () => {
  it("去空白并转小写", () => {
    expect(normalizeLogin("  Alice@Example.COM ")).toBe("alice@example.com");
  });
  it("全角经 NFKC 后合法", () => {
    expect(normalizeLogin("ａｌｉｃｅ")).toBe("alice");
  });
  it.each(["ab", "a b", "名字"])("%s 抛 validation_failed", (raw) => {
    try {
      normalizeLogin(raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("validation_failed");
    }
  });
});

describe("validatePassword", () => {
  it("过短、过长抛错，12 与 256 位通过", () => {
    expect(() => validatePassword("short")).toThrow(ApiError);
    expect(() => validatePassword("a".repeat(257))).toThrow(ApiError);
    expect(() => validatePassword("a".repeat(12))).not.toThrow();
    expect(() => validatePassword("a".repeat(256))).not.toThrow();
  });
});
