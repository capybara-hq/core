import { describe, expect, it } from "vitest";
import {
  EXTENSION_POINTS,
  isFileSystemGoneError,
  isSandboxGoneError,
  SANDBOX_EXTENSION_POINT,
  SANDBOX_ROOTS,
  SANDBOX_TAG_RE,
  SandboxGoneError,
  validateAllowHost,
  validateSandboxPath,
} from "../src/index.js";

describe("sandbox@2", () => {
  it("SANDBOX_EXTENSION_POINT is sandbox@2", () => {
    expect(SANDBOX_EXTENSION_POINT).toBe("sandbox@2");
  });

  it("isFileSystemGoneError recognises a copy from another SDK instance", () => {
    const copy = Object.assign(new Error("volume gone"), {
      name: "FileSystemGoneError",
      fileSystemGone: true,
    });
    expect(isFileSystemGoneError(copy)).toBe(true);
    expect(isFileSystemGoneError(new SandboxGoneError("x"))).toBe(false);
    expect(isFileSystemGoneError(new Error("x"))).toBe(false);
  });

  it("constants match the registry", () => {
    expect(EXTENSION_POINTS.sandbox).toBeDefined();
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

describe("SandboxGoneError", () => {
  it("带名字与 sandboxGone 标记；鸭子类型判断不依赖 instanceof", () => {
    const e = new SandboxGoneError("instance fake-1 is gone", { cause: new Error("404") });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SandboxGoneError");
    expect(e.sandboxGone).toBe(true);
    expect(e.cause).toBeInstanceOf(Error);
    expect(isSandboxGoneError(e)).toBe(true);
    // 另一份 SDK 副本抛出的同形错误
    const other = Object.assign(new Error("x"), { name: "SandboxGoneError", sandboxGone: true });
    expect(isSandboxGoneError(other)).toBe(true);
    expect(isSandboxGoneError(new Error("x"))).toBe(false);
    expect(isSandboxGoneError({ name: "SandboxGoneError", sandboxGone: true })).toBe(false);
    expect(isSandboxGoneError(null)).toBe(false);
  });

  it("SANDBOX_TAG_RE accepts kernel UUIDs and rejects anything a kill pattern could misread", () => {
    expect(SANDBOX_TAG_RE.test("0b7c3f9e-4a1d-4c2e-9f00-1234567890ab")).toBe(true);
    for (const bad of ["", "A", "a b", "a/b", "a.*", "a".repeat(65)]) {
      expect(SANDBOX_TAG_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("validateSandboxPath with an instance's roots", () => {
  const roots = { workspace: "/home/u/e1/workspace", skills: "/home/u/e1/skills", tmp: "/tmp/e1" };
  it("accepts paths under the given roots only", () => {
    expect(validateSandboxPath("/home/u/e1/workspace/a.txt", roots)).toEqual([]);
    expect(validateSandboxPath("/tmp/e1", roots)).toEqual([]);
    expect(validateSandboxPath("/workspace/a.txt", roots)).toEqual([
      "path must be under /home/u/e1/workspace, /home/u/e1/skills, /tmp/e1",
    ]);
    expect(validateSandboxPath("/home/u/e1/workspace/../x", roots)).toContain(
      "path must not contain '..' segments",
    );
  });
});
