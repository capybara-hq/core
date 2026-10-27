import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTROL_OR_HIDDEN_RE, HIDDEN_FORMAT_RE } from "../src/text.js";

describe("hidden-character rule (text.ts)", () => {
  it("keeps ZWNJ / ZWJ and strips other format characters", () => {
    expect("a‌b‍c​d‮e⁦f".replace(HIDDEN_FORMAT_RE, "")).toBe("a‌b‍cdef");
    expect(CONTROL_OR_HIDDEN_RE.test("a‍b")).toBe(false);
    expect(CONTROL_OR_HIDDEN_RE.test("a\nb")).toBe(true);
    expect(CONTROL_OR_HIDDEN_RE.test("a​b")).toBe(true);
  });

  it("writes invisible characters as escapes in the source (review M7)", () => {
    const src = readFileSync(new URL("../src/text.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/[​-‏‪-‮⁠-⁩﻿]/u);
  });

  it("the test-style regex has no global state", () => {
    expect(CONTROL_OR_HIDDEN_RE.global).toBe(false);
    expect(CONTROL_OR_HIDDEN_RE.test("​")).toBe(true);
    expect(CONTROL_OR_HIDDEN_RE.test("​")).toBe(true);
  });
});
