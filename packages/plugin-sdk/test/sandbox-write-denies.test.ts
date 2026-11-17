import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_SANDBOX_SOURCE } from "../src/sandbox-linux-runtime-source.js";
import { NATIVE_FILES_SOURCE } from "../src/sandbox-native-runtime-source.js";
import {
  isSandboxMoveDenied,
  isSandboxWriteDenied,
  SANDBOX_WRITE_POLICY_PYTHON,
  sandboxFoldName,
} from "../src/sandbox-write-denies.js";

const DENIED = [
  "/w/.git/config",
  "/w/.git/hooks/pre-commit",
  "/w/.git/hooks",
  "/w/.git/commondir",
  "/w/.git/config.worktree",
  "/w/.git/info/attributes",
  "/w/.git/unknown-file",
  "/w/.git/modules/sub/config",
  "/w/.git/modules/sub/hooks/pre-commit",
  "/w/.git/modules/a/b/config",
  "/w/.git/modules/x/objects/config",
  "/w/.git/modules/a/modules/b/config",
  "/w/.git/worktrees/wt/commondir",
  "/w/.git/worktrees/wt/config.worktree",
  "/w/.git/worktrees/wt/gitdir",
  "/w/a/.git/config",
  "/w/src/HEAD",
  "/w/bare/head",
  "/w/.bashrc",
  "/w/x/.ZSHRC",
  "/w/.envrc",
  "/w/deep/.npmrc",
  "/w/.ｂａｓｈｒｃ",
  "/w/.ＶＳＣＯＤＥ/settings.json",
  "/w/.vscode/settings.json",
  "/w/.idea",
  "/w/.claude/commands/c.md",
  "/w/.claude/agents",
  "/w/.mcp.json",
  "/w/.gitmodules",
  "/w/.git/objects/zz/.git/HEAD",
  "/w/.git/objects/zz/.git/config",
  "/w/.git/objects/yy/HEAD",
  "/w/.git/refs/heads/x/HEAD",
  "/w/.git/logs/objects",
  "/w/.git/logs/commondir",
  "/w/.git/refs/remotes/o/objects",
  "/w/.git/sequencer/objects",
  "/w/.git/modules/sub/objects/zz/.git/config",
  "/w/.husky/pre-commit",
  "/w/.pre-commit-config.yaml",
  "/w/lefthook.yml",
  "/w/.lefthook/x",
  "/w/.config/lefthook.yml",
  "/w/.githooks/pre-commit",
  "/w/.huskyrc",
  "/w/.baſhrc",
  "/w/.ﬁx/../.bashrc",
];
const ALLOWED = [
  "/w/src/a.ts",
  "/w/.git",
  "/w/.git/HEAD",
  "/w/.git/index",
  "/w/.git/index.lock",
  "/w/.git/objects/ab/cdef",
  "/w/.git/refs/heads/main.lock",
  "/w/.git/refs/heads/config",
  "/w/.git/logs/HEAD",
  "/w/.git/COMMIT_EDITMSG",
  "/w/.git/info",
  "/w/.git/info/exclude",
  "/w/.git/rebase-merge/git-rebase-todo",
  "/w/.git/modules/sub/objects/ab/cd",
  "/w/.git/modules/sub/HEAD",
  "/w/.git/worktrees/wt/HEAD",
  "/w/.claude/x",
  "/w/.git/logs/HEAD",
  "/w/.git/logs/refs/remotes/origin/HEAD",
  "/w/.git/refs/remotes/origin/HEAD",
  "/w/.git/sequencer/head",
  "/w/.git/modules/sub/logs/HEAD",
  "/w/.config/other.yml",
];
/** Names whose folding differs between toLowerCase and full case folding (and NFKC). */
const FOLDS = ["Straße", "ſ", "\u212A", "ΣΑΣ", "ς", "ǰ", "ŉ", "ᏸ", "Ꭰ", "ﬃ", "ＡＢＣ", "İ"];
const MOVES: [string, string, boolean, boolean][] = [
  ["/w/.git/index.lock", "/w/.git/index", false, false],
  ["/w/.git/objects/ab/tmp_obj", "/w/.git/objects/ab/cdef", false, false],
  ["/w/.git", "/w/g2", true, true],
  ["/w/.git/objects", "/w/objects", true, true],
  ["/w/evil", "/w/sub/.git", true, true],
  ["/w/file", "/w/sub/.git", false, true],
  ["/w/a", "/w/b", true, false],
  ["/w/.claude/x", "/w/y", false, true],
];

describe("restricted write policy", () => {
  it("denies git internals beyond the allowlist, rc and editor files, bare lookalikes", () => {
    for (const path of DENIED) expect(isSandboxWriteDenied(path), path).toBe(true);
    for (const path of ALLOWED) expect(isSandboxWriteDenied(path), path).toBe(false);
  });

  it("refuses moves out of protected names and directories into them", () => {
    for (const [from, to, dir, denied] of MOVES)
      expect(isSandboxMoveDenied(from, to, dir), `${from} -> ${to}`).toBe(denied);
  });

  it("the Python policy the launcher and the native helper embed decides identically", () => {
    expect(LINUX_SANDBOX_SOURCE).toContain(SANDBOX_WRITE_POLICY_PYTHON);
    expect(NATIVE_FILES_SOURCE).toContain(SANDBOX_WRITE_POLICY_PYTHON);
    const program = `${SANDBOX_WRITE_POLICY_PYTHON}
import json, sys
data = json.loads(sys.stdin.read())
print(json.dumps({"writes": [write_denied(p) for p in data["paths"]],
                  "moves": [move_denied(a, b, d) for a, b, d in data["moves"]],
                  "folds": _fold_parts("/".join(data["folds"]))}))
`;
    const paths = [...DENIED, ...ALLOWED];
    const out = JSON.parse(
      execFileSync("python3", ["-I", "-c", program], {
        input: JSON.stringify({ paths, moves: MOVES.map(([a, b, d]) => [a, b, d]), folds: FOLDS }),
        encoding: "utf8",
      }),
    ) as { writes: boolean[]; moves: boolean[]; folds: string[] };
    // the same full case folding on both sides (toLowerCase alone differs on most of these)
    expect(FOLDS.map(sandboxFoldName)).toEqual(out.folds);
    expect(out.writes).toEqual(paths.map(isSandboxWriteDenied));
    expect(out.moves).toEqual(MOVES.map(([a, b, d]) => isSandboxMoveDenied(a, b, d)));
  });
});
