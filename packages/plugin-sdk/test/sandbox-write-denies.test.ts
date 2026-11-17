import { describe, expect, it } from "vitest";
import { LINUX_SANDBOX_SOURCE } from "../src/sandbox-linux-runtime-source.js";
import { NATIVE_FILES_SOURCE } from "../src/sandbox-native-runtime-source.js";
import { isSandboxWriteDenied, SANDBOX_PROTECTED_PATH_NAMES } from "../src/sandbox-write-denies.js";

describe("mandatory write denies", () => {
  it("covers git configuration and hooks, shell startup and editor/agent files at any depth", () => {
    for (const path of [
      "/w/.git/config",
      "/w/a/b/.git/hooks/pre-commit",
      "/w/.git/hooks",
      "/w/sub/.git/commondir",
      "/w/.git/config.worktree",
      "/w/.bashrc",
      "/w/x/.ZSHRC",
      "/w/.vscode/settings.json",
      "/w/.idea",
      "/w/.claude/commands/c.md",
      "/w/.claude/agents",
      "/w/.mcp.json",
      "/w/.gitmodules",
    ])
      expect(isSandboxWriteDenied(path), path).toBe(true);
  });
  it("leaves ordinary files and the rest of .git writable", () => {
    for (const path of ["/w/src/a.ts", "/w/.git/HEAD", "/w/.git/objects/ab/cd", "/w/.claude/x"])
      expect(isSandboxWriteDenied(path), path).toBe(false);
    expect(SANDBOX_PROTECTED_PATH_NAMES).toContain(".git");
  });
  it("is the one list the Linux launcher and the native helper embed", () => {
    expect(LINUX_SANDBOX_SOURCE).toContain(
      'MANDATORY_WRITE_DENIES = [[name.lower() for name in entry] for entry in [[".gitconfig"]',
    );
    expect(NATIVE_FILES_SOURCE).toContain(
      'WRITE_DENIES = [[name.lower() for name in entry] for entry in [[".gitconfig"]',
    );
  });
});
