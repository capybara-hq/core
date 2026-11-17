import { describe, expect, it } from "vitest";
import { macWriteRegexRules } from "../src/exec/mac-write-policy.js";

describe("macOS write policy rules", () => {
  it("escapes the root, keeps every regex within Seatbelt's string limit, ends with the .git move rule", () => {
    const rules = macWriteRegexRules("/Users/me/a.b+(c)[d]{e}|f^$\\g");
    for (const rule of rules) {
      expect(
        rule.regex.startsWith("^/Users/me/a\\.b\\+\\(c\\)\\[d\\]\\{e\\}\\|f\\^\\$\\\\g/"),
      ).toBe(true);
      expect(rule.regex.length).toBeLessThanOrEqual(1000);
      expect(rule.regex).not.toContain('"');
    }
    expect(rules.at(-1)).toMatchObject({
      action: "deny",
      operations: ["file-write-unlink", "file-write-create"],
    });
    expect(rules.filter((rule) => rule.action === "allow").length).toBeGreaterThan(0);
  });

  it("fails closed for a root too long to express", () => {
    expect(() => macWriteRegexRules(`/${"x".repeat(1200)}`)).toThrow(/too long/);
  });
});
