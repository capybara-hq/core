import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { macWriteRegexRules, macWriteRootSpellings } from "../src/exec/mac-write-policy.js";

describe("macOS write root spellings", () => {
  it("adds the real on-disk path and the /private form, and refuses control characters", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cap-spell-")));
    try {
      await mkdir(join(base, "Target"));
      symlinkSync(join(base, "Target"), join(base, "link"));
      expect(macWriteRootSpellings(join(base, "link", "missing"))).toEqual([
        join(base, "link", "missing"),
        join(base, "Target", "missing"),
      ]);
      // on-disk case for a differently cased spelling (case-insensitive file systems)
      const cased = macWriteRootSpellings(join(base, "target"));
      expect(cased).toEqual([join(base, "target")]);
      expect(macWriteRootSpellings("/tmp/x")).toEqual(
        process.platform === "darwin" ? ["/tmp/x", "/private/tmp/x"] : ["/tmp/x", "/private/tmp/x"],
      );
      expect(() => macWriteRootSpellings("/a\nb")).toThrow(/control character/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

const PREFIX = String.raw`^/[uU][sS][eE][rR][sS]/[mM][eE]/[aA]\.[bB]\+\([cC]\)\[[dD]\]\{[eE]\}\|[fF]\^\$\\[gG]/`;

describe("macOS write policy rules", () => {
  it("escapes the root, keeps every regex within Seatbelt's string limit, ends with the .git move rule", () => {
    const rules = macWriteRegexRules("/Users/me/a.b+(c)[d]{e}|f^$\\g");
    for (const rule of rules) {
      // escaped, and its letters matched in either case
      expect(rule.regex.startsWith(PREFIX)).toBe(true);
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
