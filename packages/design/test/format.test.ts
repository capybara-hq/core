import { describe, expect, it } from "vitest";
import { formatCompact } from "../src/index";

// formatCompact (admin overview design §8.2): token counts and other large numbers, compact per
// locale: en in thousands (K / M / B / T), zh in 万 / 亿 / 万亿, at most one decimal.

describe("formatCompact", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [1060, "1.1K"],
    [12_345, "12.3K"],
    [123_456, "123K"],
    [999_499, "999K"],
    [999_950, "1M"],
    [3_400_000, "3.4M"],
    [21_700_000, "21.7M"],
    [100_000_000, "100M"],
    [2_500_000_000, "2.5B"],
    [1e12, "1T"],
    [-12_345, "-12.3K"],
    [12.34, "12.3"],
  ])("en %d → %s", (n, out) => {
    expect(formatCompact(n, "en")).toBe(out);
  });

  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1,000"],
    [9999, "9,999"],
    [12_345, "1.2万"],
    [3_400_000, "340万"],
    [3_456_789, "346万"],
    [99_995_000, "1亿"],
    [100_000_000, "1亿"],
    [1_234_000_000, "12.3亿"],
    [2e12, "2万亿"],
    [-12_345, "-1.2万"],
  ])("zh %d → %s", (n, out) => {
    expect(formatCompact(n, "zh")).toBe(out);
  });

  it("treats a regional zh tag as zh and anything else as en", () => {
    expect(formatCompact(3_400_000, "zh-CN")).toBe("340万");
    expect(formatCompact(3_400_000, "de")).toBe("3.4M");
  });

  it("decides the sign after rounding: no negative zero", () => {
    expect(formatCompact(-0.04, "en")).toBe("0");
    expect(formatCompact(-0.04, "zh")).toBe("0");
    expect(formatCompact(-0.4, "en")).toBe("-0.4");
    expect(formatCompact(-999_950, "en")).toBe("-1M");
  });

  it("draws a dash for what is not a finite number", () => {
    expect(formatCompact(Number.NaN, "en")).toBe("—");
    expect(formatCompact(Number.POSITIVE_INFINITY, "zh")).toBe("—");
  });
});
