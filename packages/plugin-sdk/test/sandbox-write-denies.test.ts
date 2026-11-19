import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LINUX_SANDBOX_SOURCE } from "../src/sandbox-linux-runtime-source.js";
import { NATIVE_FILES_SOURCE } from "../src/sandbox-native-runtime-source.js";
import {
  isSandboxMoveDenied,
  isSandboxWriteDenied,
  SANDBOX_MANDATORY_WRITE_DENIES,
  SANDBOX_WRITE_POLICY_PYTHON,
  sandboxFoldName,
} from "../src/sandbox-write-denies.js";

/**
 * The persistence vectors of the approval-only profiles design ("Fixed denies"): launchd agents and
 * daemons, systemd user units, XDG autostart and the crontab spool, in every spelling a consumer
 * may see (APFS case folding, full Unicode case folding, the `/private` and Data-volume forms of
 * macOS, the Linux spool layouts).
 */
const PERSISTENCE_DENIED = [
  "/Users/u/Library/LaunchAgents",
  "/Users/u/Library/LaunchAgents/com.evil.plist",
  "/users/u/library/launchagents/com.evil.plist",
  "/Users/u/LIBRARY/LAUNCHAGENTS/com.evil.plist",
  "/Users/u/Library/LaunchAgentſ/com.evil.plist",
  "/Users/u/Ｌibrary/LaunchAgents/com.evil.plist",
  "/System/Volumes/Data/Users/u/Library/LaunchAgents/com.evil.plist",
  "/private/var/root/Library/LaunchAgents/x.plist",
  "/Library/LaunchAgents/com.evil.plist",
  "/Library/LaunchDaemons",
  "/Library/LaunchDaemons/com.evil.plist",
  "/Users/u/Library/LaunchDaemons/com.evil.plist",
  "/library/launchdaemons/com.evil.plist",
  "/home/u/.config/systemd/user",
  "/home/u/.config/systemd/user/evil.service",
  "/home/u/.config/systemd/user/default.target.wants/evil.service",
  "/home/u/.CONFIG/Systemd/USER/evil.service",
  "/home/u/.config/autostart",
  "/home/u/.config/autostart/evil.desktop",
  "/home/u/.config/AutoStart/evil.desktop",
  "/private/var/at/tabs/u",
  "/var/at/tabs/u",
  "/private/var/at/tabs",
  "/PRIVATE/VAR/AT/TABS/u",
  "/var/spool/cron/crontabs/u",
  "/var/spool/cron/u",
  "/var/spool/cron/tabs/u",
  "/var/spool/cron",
  "/VAR/SPOOL/CRON/crontabs/u",
];
const PERSISTENCE_ALLOWED = [
  "/Users/u/Library/Caches/x",
  "/Users/u/Library",
  "/Users/u/LaunchAgents/x.plist",
  "/home/u/.config/systemd",
  "/home/u/.config/systemd/system.conf",
  "/home/u/.config/autostart-scripts.txt",
  "/var/spool/mail/u",
  "/private/var/at/jobs/x",
  "/w/src/cron/job.ts",
  "/w/tabs/at.ts",
];

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
  "/w/.git/index.stash.x",
  "/w/.git/index.stash.",
  "/w/.baſhrc",
  "/w/.ﬁx/../.bashrc",
  ...PERSISTENCE_DENIED,
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
  "/w/.git/index.stash.12345",
  "/w/.git/index.stash.12345.lock",
  "/w/.git/packed-refs.new",
  "/w/.git/MERGE_AUTOSTASH",
  ...PERSISTENCE_ALLOWED,
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
  // a persistence directory is not moved away, edited and moved back
  ["/Users/u/Library", "/Users/u/L2", true, true],
  ["/Users/u/L2", "/Users/u/Library", true, true],
  ["/home/u/.config/systemd", "/home/u/sd", true, true],
  ["/var/spool", "/var/sp2", true, true],
  ["/var/at", "/var/at2", true, true],
  // ordinary directory names stay movable
  ["/w/var/cache/x", "/w/x", false, false],
  ["/w/usr/lib/x", "/w/x", false, false],
  ["/w/src/cron/job.ts", "/w/job.ts", false, false],
];

describe("restricted write policy", () => {
  it("denies git internals beyond the allowlist, rc and editor files, bare lookalikes", () => {
    for (const path of DENIED) expect(isSandboxWriteDenied(path), path).toBe(true);
    for (const path of ALLOWED) expect(isSandboxWriteDenied(path), path).toBe(false);
  });

  it("writes every mandatory entry already folded (the TypeScript side compares folded names)", () => {
    for (const entry of SANDBOX_MANDATORY_WRITE_DENIES)
      for (const name of entry) expect(sandboxFoldName(name), name).toBe(name);
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
