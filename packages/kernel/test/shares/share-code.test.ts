import { describe, expect, it } from "vitest";
import { newShareCode, SHARE_CODE_RE } from "../../src/shares/share-code.js";

describe("share codes (file sharing spec §1)", () => {
  it("10 000 codes all match the pattern and none repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const code = newShareCode();
      expect(code).toMatch(SHARE_CODE_RE);
      seen.add(code);
    }
    expect(seen.size).toBe(10_000);
  });

  it("skips bytes at or above 248 (rejection sampling keeps every character equally likely)", () => {
    const calls: number[] = [];
    const random = (n: number): Buffer => {
      calls.push(n);
      // the first call returns two rejected bytes, then values that map to A, B, C, …
      const first = calls.length === 1;
      return Buffer.from(
        Array.from({ length: n }, (_, i) =>
          first && i < 2 ? (i === 0 ? 248 : 255) : i - (first ? 2 : 0),
        ),
      );
    };
    const code = newShareCode(random);
    expect(code).toMatch(SHARE_CODE_RE);
    expect(code[0]).toBe("A");
    expect(code.slice(0, 3)).toBe("ABC");
  });

  it("maps a byte by its remainder modulo 62 (62 → A, 61 and 247 → 9)", () => {
    const bytes = [62, 61, 124, 186, 247, 0, 26, 52, 1, 2];
    const code = newShareCode((n) => Buffer.from(bytes.slice(0, n)));
    expect(code).toBe("A9AA9Aa0BC");
  });
});
