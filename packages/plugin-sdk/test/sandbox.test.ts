import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  SANDBOX_CAPABILITY,
  SANDBOX_ROOTS,
  validateAllowHost,
  validateSandboxPath,
} from "../src/index.js";

describe("sandbox@1", () => {
  it("常量与登记一致", () => {
    expect(SANDBOX_CAPABILITY).toBe("sandbox@1");
    expect(CAPABILITIES.sandbox).toBeDefined();
    expect([...SANDBOX_ROOTS]).toEqual(["/workspace", "/skills", "/tmp"]);
  });

  it.each([
    "/workspace",
    "/skills",
    "/tmp",
    "/workspace/a/b.txt",
    "/skills/x/SKILL.md",
    "/tmp/a b/c",
    "/workspace/a..b",
    "/workspace/.hidden",
  ])("合法路径 %s", (p) => {
    expect(validateSandboxPath(p)).toEqual([]);
  });

  it.each([
    "../etc",
    "workspace/a",
    "",
    "/etc/passwd",
    "/workspace/../etc",
    "/workspace/..",
    "/workspace/%2e%2e/etc",
    "/workspace/%2E%2e/etc",
    "/workspace/.%2E/etc",
    "/workspacex",
    "/workspacex/a",
    "/tmpfoo",
    "/workspace//a",
    "/workspace\\a",
    "/workspace/a\0b",
    "/workspace/a\nb",
    "/workspace/a\x7fb",
    `/workspace/${"a".repeat(4096)}`,
  ])("非法路径 %j", (p) => {
    expect(validateSandboxPath(p).length).toBeGreaterThan(0);
  });

  it("合法主机名", () => {
    for (const h of ["github.com", "*.npmjs.org", "xn--bcher-kva.example", "api.example.co"]) {
      expect(validateAllowHost(h)).toEqual([]);
    }
  });

  it("非法主机名", () => {
    for (const h of [
      "",
      "GitHub.com",
      "https://github.com",
      "github.com:443",
      "github.com/x",
      "*",
      "*.",
      "a.*.com",
      "**.com",
      "bücher.example",
      "-a.com",
      "a..com",
      "a b.com",
      "127.0.0.1",
      "127.1",
      "0x7f000001",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "2130706433",
      "*.10.0.0.1",
      "[::1]",
      "::1",
      "[::ffff:127.0.0.1]",
      "localhost",
      "metadata",
      "*.localhost",
      "foo.localhost",
      "printer.local",
      "db.internal",
      "*.internal",
    ]) {
      expect(validateAllowHost(h).length, h).toBeGreaterThan(0);
    }
  });
});
