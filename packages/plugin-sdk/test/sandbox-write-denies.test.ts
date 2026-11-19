import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LINUX_SANDBOX_SOURCE } from "../src/sandbox-linux-runtime-source.js";
import { NATIVE_FILES_SOURCE } from "../src/sandbox-native-runtime-source.js";
import {
  isSandboxMoveDenied,
  isSandboxWriteDenied,
  SANDBOX_MANDATORY_WRITE_DENIES,
  SANDBOX_PROTECTED_PATH_NAMES,
  SANDBOX_SYSTEM_WRITE_DENIES,
  SANDBOX_WRITE_POLICY_PYTHON,
  sandboxFoldName,
} from "../src/sandbox-write-denies.js";

/**
 * The persistence vectors of the approval-only profiles design ("Fixed denies"): launchd agents and
 * daemons, systemd units and environment, XDG and KDE autostart, X session files, every shell
 * startup and logout file, fish configuration and the crontab and at spools, in every spelling a
 * consumer may see (APFS case folding, full Unicode case folding, the `/private` and Data-volume
 * forms of macOS, the Linux spool layouts).
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
  "/home/u/.config/systemd",
  "/home/u/.config/systemd/user",
  "/home/u/.config/systemd/user/evil.service",
  "/home/u/.config/systemd/user/default.target.wants/evil.service",
  "/home/u/.config/systemd/user.control/evil.service",
  "/home/u/.config/systemd/user.conf",
  "/home/u/.config/systemd/user.conf.d/env.conf",
  "/home/u/.CONFIG/Systemd/USER/evil.service",
  "/home/u/.local/share/systemd/user/evil.service",
  "/home/u/.LOCAL/Share/SYSTEMD",
  "/home/u/.config/environment.d/90-evil.conf",
  "/home/u/.config/autostart",
  "/home/u/.config/autostart/evil.desktop",
  "/home/u/.config/AutoStart/evil.desktop",
  "/home/u/.config/autostart-scripts/evil.sh",
  "/home/u/.config/plasma-workspace/env/evil.sh",
  "/home/u/.xprofile",
  "/home/u/.xsessionrc",
  "/home/u/.zshenv",
  "/home/u/.zlogin",
  "/home/u/.zlogout",
  "/home/u/.bash_login",
  "/home/u/.bash_logout",
  "/home/u/.tcshrc",
  "/home/u/.cshrc",
  "/home/u/.kshrc",
  "/home/u/.logout",
  "/home/u/.config/git/config",
  "/home/u/.config/fish/config.fish",
  "/home/u/.config/fish/conf.d/evil.fish",
  "/home/u/.config/fish/conf.d",
  "/private/var/at/tabs/u",
  "/private/var/at/tabs",
  "/private/var/at/jobs/x",
  "/PRIVATE/VAR/AT/TABS/u",
  "/var/at",
  "/var/at/tabs/u",
  "/var/at/jobs/x",
  "/var/spool/cron/crontabs/u",
  "/var/spool/cron/u",
  "/var/spool/cron/tabs/u",
  "/var/spool/cron",
  "/VAR/SPOOL/CRON/crontabs/u",
  "/var/spool/at/a0001",
];
const PERSISTENCE_ALLOWED = [
  "/Users/u/Library/Caches/x",
  "/Users/u/Library",
  "/Users/u/LaunchAgents/x.plist",
  "/home/u/.config",
  "/home/u/.config/systemd-not/x",
  "/home/u/.config/autostart-scripts.txt",
  "/home/u/.config/plasma-workspace/shutdown/x.sh",
  "/home/u/.config/fish/functions/f.fish",
  "/home/u/.local/share/other/x",
  "/home/u/.config/git/ignore",
  "/var/spool/mail/u",
  "/var/spool",
  "/private/var/folders/xy/T/x",
  "/w/src/cron/job.ts",
  "/w/tabs/at.ts",
  "/w/at/tabs/x",
  "/w/spool/cron/x",
  "/w/var/spool/cron/x",
  "/w/private/var/at/x",
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
/** [source, destination, source is a directory, refused, the source directory's entries]. */
const MOVES: [string, string, boolean, boolean, string[]?][] = [
  ["/w/.git/index.lock", "/w/.git/index", false, false],
  ["/w/.git/objects/ab/tmp_obj", "/w/.git/objects/ab/cdef", false, false],
  ["/w/.git", "/w/g2", true, true],
  ["/w/.git/objects", "/w/objects", true, true],
  ["/w/evil", "/w/sub/.git", true, true],
  ["/w/file", "/w/sub/.git", false, true],
  ["/w/a", "/w/b", true, false, []],
  ["/w/.husky/pre-commit", "/w/x", false, true],
  ["/w/.claude/commands/c.md", "/w/y", false, true],
  ["/w/.claude/x", "/w/y", false, false],
  // ordinary directory names stay movable, also when they begin a multi-component entry
  ["/w/src/library/a.ts", "/w/a.ts", false, false],
  ["/w/lib", "/w/library", true, false, ["a.ts", "b"]],
  ["/w/library", "/w/lib", true, false, ["LaunchAgents"]],
  ["/w/.gradle/at/stash", "/w/.gradle/stash", true, false, ["x.bin"]],
  ["/w/src/main/java/at/example/A.java", "/w/src/main/java/at/sample/A.java", false, false],
  ["/w/src/main/java/at/example", "/w/src/main/java/at/sample", true, false, ["A.java"]],
  ["/w/spool", "/w/spool2", true, false, ["cron"]],
  ["/w/q", "/w/spool", true, false, ["cron"]],
  ["/w/var/cache/x", "/w/x", false, false],
  ["/w/src/cron/job.ts", "/w/job.ts", false, false],
  ["/w/x", "/w/.config", true, false, ["nvim"]],
  ["/Users/u/Library", "/Users/u/L2", true, false, ["LaunchAgents"]],
  // a prepared directory never moves into place: a destination ending in a prefix of an entry
  // takes no source holding the entry's next component
  ["/Users/u/L2", "/Users/u/Library", true, true, ["LaunchAgents"]],
  ["/w/prep", "/Users/u/Library", true, true, ["Caches", "launchagents"]],
  ["/w/prep", "/Users/u/LIBRARY", true, true, ["LaunchDaemonſ"]],
  ["/w/prep", "/Users/u/Library", true, false, ["Caches"]],
  ["/w/prep", "/Users/u/Library", true, true],
  ["/w/prep", "/home/u/.config", true, true, ["systemd"]],
  ["/w/prep", "/home/u/.config", true, true, ["fish"]],
  ["/w/prep", "/home/u/.config/fish", true, true, ["conf.d"]],
  ["/w/prep", "/home/u/.config/fish", true, false, ["functions"]],
  ["/w/prep", "/home/u/.local", true, true, ["share"]],
  ["/w/prep", "/home/u/.local/share", true, true, ["systemd"]],
  ["/w/prep", "/w/.claude", true, true, ["commands"]],
  ["/w/prep", "/home/u/.config/systemd", true, true, []],
  // a link (or file) never takes a prefix name: a link there would point the entry elsewhere
  ["/w/link", "/Users/u/Library", false, true],
  ["/w/link", "/home/u/.config/fish", false, true],
  // the system spools are anchored absolute paths
  // an anchored deny's ancestor never moves away (a link resolved into it would dangle)
  ["/var/spool", "/var/sp2", true, true, ["mail"]],
  ["/var", "/v2", true, true, []],
  ["/private/var/at", "/private/var/at2", true, true, []],
  ["/var/spool/mail", "/var/spool/mail2", true, false, []],
  ["/var/sp2", "/var/spool", true, true, ["cron"]],
  ["/var/sp2", "/var/spool", true, false, ["mail"]],
  ["/tmp/prep", "/var", true, true, ["at"]],
  ["/var/at", "/var/at2", true, true, ["tabs"]],
];

describe("restricted write policy", () => {
  it("denies git internals beyond the allowlist, rc and editor files, bare lookalikes", () => {
    for (const path of DENIED) expect(isSandboxWriteDenied(path), path).toBe(true);
    for (const path of ALLOWED) expect(isSandboxWriteDenied(path), path).toBe(false);
  });

  it("writes every mandatory entry already folded (the TypeScript side compares folded names)", () => {
    for (const entry of SANDBOX_MANDATORY_WRITE_DENIES)
      for (const name of entry) expect(sandboxFoldName(name), name).toBe(name);
    for (const path of SANDBOX_SYSTEM_WRITE_DENIES) {
      expect(path.startsWith("/"), path).toBe(true);
      expect(sandboxFoldName(path), path).toBe(path);
    }
  });

  it("refuses moves out of protected names and directories into them", () => {
    for (const [from, to, dir, denied, children] of MOVES)
      expect(isSandboxMoveDenied(from, to, dir, children), `${from} -> ${to}`).toBe(denied);
  });

  it("takes protected move names only from single-component entries", () => {
    const single = SANDBOX_MANDATORY_WRITE_DENIES.filter((e) => e.length === 1).map((e) => e[0]);
    expect(new Set(SANDBOX_PROTECTED_PATH_NAMES)).toEqual(new Set([".git", ...single]));
    for (const name of ["library", "at", "spool", ".config", ".local", ".claude", "var"])
      expect(SANDBOX_PROTECTED_PATH_NAMES, name).not.toContain(name);
  });

  it("the Python policy lists the source directory itself when no entries are given", () => {
    const dir = mkdtempSync(join(tmpdir(), "move-policy-"));
    try {
      mkdirSync(join(dir, "prep", "LaunchAgents"), { recursive: true });
      mkdirSync(join(dir, "plain", "Caches"), { recursive: true });
      const program = `${SANDBOX_WRITE_POLICY_PYTHON}
import json, sys
d = sys.argv[1]
print(json.dumps([move_denied(d + "/prep", "/Users/u/Library", True),
                  move_denied(d + "/plain", "/Users/u/Library", True),
                  move_denied(d + "/missing", "/Users/u/Library", True)]))
`;
      const out = JSON.parse(
        execFileSync("python3", ["-I", "-c", program, dir], { encoding: "utf8" }),
      ) as boolean[];
      // a source that cannot be listed is refused
      expect(out).toEqual([true, false, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Python policy the launcher and the native helper embed decides identically", () => {
    expect(LINUX_SANDBOX_SOURCE).toContain(SANDBOX_WRITE_POLICY_PYTHON);
    expect(NATIVE_FILES_SOURCE).toContain(SANDBOX_WRITE_POLICY_PYTHON);
    const program = `${SANDBOX_WRITE_POLICY_PYTHON}
import json, sys
data = json.loads(sys.stdin.read())
print(json.dumps({"writes": [write_denied(p) for p in data["paths"]],
                  "moves": [move_denied(a, b, d, c) for a, b, d, c in data["moves"]],
                  "folds": _fold_parts("/".join(data["folds"]))}))
`;
    const paths = [...DENIED, ...ALLOWED];
    const out = JSON.parse(
      execFileSync("python3", ["-I", "-c", program], {
        input: JSON.stringify({
          paths,
          moves: MOVES.map(([a, b, d, , c]) => [a, b, d, c ?? null]),
          folds: FOLDS,
        }),
        encoding: "utf8",
      }),
    ) as { writes: boolean[]; moves: boolean[]; folds: string[] };
    // the same full case folding on both sides (toLowerCase alone differs on most of these)
    expect(FOLDS.map(sandboxFoldName)).toEqual(out.folds);
    expect(out.writes).toEqual(paths.map(isSandboxWriteDenied));
    expect(out.moves).toEqual(MOVES.map(([a, b, d, , c]) => isSandboxMoveDenied(a, b, d, c)));
  });
});
