import { describe, expect, it } from "vitest";
import { sanitizeToolTitle } from "../../src/tools/drift.js";

// Remote tool titles are display only, but they sit next to the reviewed tool key on the approval
// block: they must not reorder, hide or break that line (UI refresh B, fix I2).

describe("sanitizeToolTitle", () => {
  it("removes bidi overrides and isolates, and invisible characters", () => {
    expect(sanitizeToolTitle("Read‮file")).toBe("Readfile");
    expect(sanitizeToolTitle("a⁦b⁧c⁨d⁩e")).toBe("abcde");
    expect(sanitizeToolTitle("zero​width‌‍⁠﻿")).toBe("zerowidth");
  });

  it("turns controls and newlines into one space, collapses runs and trims", () => {
    expect(sanitizeToolTitle("a\nb")).toBe("a b");
    expect(sanitizeToolTitle("  a \t\r\n  b\u0007c\u0085 ")).toBe("a b c");
    expect(sanitizeToolTitle("a b  c")).toBe("a b c");
  });

  it("cuts to 80 code points after cleaning, with no trailing space", () => {
    expect(sanitizeToolTitle(`${"​".repeat(10)}${"x".repeat(100)}`)).toBe("x".repeat(80));
    expect(sanitizeToolTitle(`${"x".repeat(79)} y`)).toBe("x".repeat(79));
    expect(sanitizeToolTitle("😀".repeat(81))).toBe("😀".repeat(80));
  });

  it("returns undefined for a title that is empty after cleaning, or not a string", () => {
    expect(sanitizeToolTitle("​")).toBeUndefined();
    expect(sanitizeToolTitle(" \n‮ ")).toBeUndefined();
    expect(sanitizeToolTitle("")).toBeUndefined();
    expect(sanitizeToolTitle(42)).toBeUndefined();
    expect(sanitizeToolTitle(undefined)).toBeUndefined();
  });

  it("keeps ordinary text as is", () => {
    expect(sanitizeToolTitle("发送消息")).toBe("发送消息");
    expect(sanitizeToolTitle("Search messages")).toBe("Search messages");
  });
});
