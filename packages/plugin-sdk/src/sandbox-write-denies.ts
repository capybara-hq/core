/**
 * What restricted execution may never write inside a granted root: one policy for every consumer
 * (the Linux launcher's broker, `native-files.py`, the device agent and, as far as its glob
 * patterns can express it, the macOS runtime). It keeps a later unsandboxed tool run by the owner
 * from executing what a restricted command left behind.
 *
 * 1. {@link SANDBOX_MANDATORY_WRITE_DENIES}: component sequences denied wherever they appear (the
 *    entry and everything beneath it): shell startup and logout files, git's global files, direnv
 *    and npm configuration, editor and agent configuration, and the OS persistence locations
 *    (launchd, systemd, environment.d, XDG and KDE autostart, X session files, fish). Entries are
 *    written already folded. {@link SANDBOX_SYSTEM_WRITE_DENIES}: absolute system paths denied
 *    with everything beneath them (the crontab and at spools), anchored at `/`.
 * 2. Inside a `.git` directory (the first `.git` component of a path) only git's ordinary
 *    internals are writable, an allowlist ({@link SANDBOX_GIT_ALLOWED_DIRECTORIES},
 *    {@link SANDBOX_GIT_ALLOWED_FILES}, `info/exclude`). Everything else there is denied:
 *    `config`, `config.worktree`, `commondir`, `gitdir`, `hooks/**`, `info/attributes`, unknown
 *    names. The gitdirs of submodules (`modules/<name>/`, where a name may contain `/`) and
 *    worktrees (`worktrees/<name>/`) follow the same allowlist; a submodule path is refused when
 *    any reading of its name would make it a denied internal.
 * 3. Outside `.git`, a file named `HEAD` is denied: with `objects/` and `refs/` it would make a
 *    bare-repository lookalike whose configuration git honours.
 * 4. Moves ({@link isSandboxMoveDenied}): neither end may be a denied write; nothing leaves a
 *    protected name ({@link SANDBOX_PROTECTED_PATH_NAMES}: `.git` and the single-component
 *    entries) except within the same protected directory; a directory is not moved under a
 *    protected name from outside it; no non-directory becomes `.git` (a `gitdir:` pointer). For a
 *    multi-component entry `[a, b, …]` (or an absolute system path) a destination ending in a
 *    proper prefix of it (`…/a`) takes no non-directory (a link there would redirect the entry)
 *    and no directory holding the entry's next component (`b`): a prepared directory never moves
 *    into place, while ordinary names (`library`, `.config`) stay movable.
 *
 * 5. Inside an allowlisted subtree nothing can make a repository: no `.git`, no `HEAD` except
 *    where git keeps one (`logs/HEAD`, `refs/remotes/<r>/HEAD`, …), and no `objects`, `commondir`
 *    or `gitdir` beside such a `HEAD`.
 *
 * Names are compared after Unicode NFKC normalization and full case folding
 * ({@link sandboxFoldName}, identical to Python's `casefold`). Known limitations: a
 * restricted command cannot `git init`, add a submodule or worktree, or create a bare repository;
 * continuing an operation it started (`git rebase --continue`) runs the todo list it wrote, like
 * any script it wrote; files that tools execute by convention without configuration (for example
 * `package.json` scripts) are not covered; a forged rebase or cherry-pick in progress is possible
 * (its state directories are writable for git's own use) and continuing it runs its `exec` lines.
 * The macOS worker expresses this policy as ordered Seatbelt regex rules
 * (`packages/device/src/exec/mac-write-policy.ts`).
 *
 * Constraints on consumers:
 *
 * - The policy judges the path it is given. A protected home location reached through a symbolic
 *   link (`~/.config` or `~/Library` linked elsewhere, as dotfile managers do) is denied only at
 *   its resolved target: a device worker resolves the protected home locations at operation start
 *   and adds their resolved targets as absolute denies.
 * - The move check needs the entries of a moved directory. A consumer passes them from the source
 *   descriptor; the Python `move_denied` otherwise lists the source path, refusing when it cannot.
 *   A listing is a snapshot: a concurrent writer could add the next component between the check
 *   and the rename, so a consumer that can re-checks the destination after the rename.
 */
export const SANDBOX_MANDATORY_WRITE_DENIES: readonly (readonly string[])[] = Object.freeze(
  [
    [".gitconfig"],
    [".gitmodules"],
    [".bashrc"],
    [".bash_profile"],
    [".zshrc"],
    [".zprofile"],
    [".profile"],
    [".ripgreprc"],
    [".mcp.json"],
    [".envrc"],
    [".npmrc"],
    [".vscode"],
    [".idea"],
    [".claude", "commands"],
    [".claude", "agents"],
    // hook managers: hooks git runs (through a manager) from files in the working tree
    [".husky"],
    [".huskyrc"],
    [".huskyrc.json"],
    [".huskyrc.js"],
    ["husky.config.js"],
    [".pre-commit-config.yaml"],
    [".pre-commit-config.yml"],
    ["lefthook.yml"],
    ["lefthook.yaml"],
    ["lefthook.json"],
    ["lefthook.toml"],
    [".lefthook.yml"],
    [".lefthook.yaml"],
    [".lefthook.json"],
    [".lefthook.toml"],
    ["lefthook-local.yml"],
    ["lefthook-local.yaml"],
    ["lefthook-local.json"],
    ["lefthook-local.toml"],
    [".lefthook-local.yml"],
    [".lefthook-local.yaml"],
    [".lefthook-local.json"],
    [".lefthook-local.toml"],
    [".lefthook"],
    [".lefthook-local"],
    [".config", "lefthook.yml"],
    [".config", "lefthook.yaml"],
    [".config", "lefthook.json"],
    [".config", "lefthook.toml"],
    [".overcommit.yml"],
    [".simple-git-hooks.json"],
    [".simple-git-hooks.js"],
    [".simple-git-hooks.cjs"],
    ["simple-git-hooks.json"],
    ["simple-git-hooks.js"],
    ["simple-git-hooks.cjs"],
    // the conventional core.hooksPath directory a repository's existing config may name
    [".githooks"],
    // every other shell startup and logout file (the kernel review's persistence rules name them)
    [".zshenv"],
    [".zlogin"],
    [".zlogout"],
    [".bash_login"],
    [".bash_logout"],
    [".logout"],
    [".tcshrc"],
    [".cshrc"],
    [".kshrc"],
    [".config", "git", "config"],
    [".config", "fish", "config.fish"],
    [".config", "fish", "conf.d"],
    // persistence locations the OS runs later (approval-only profiles design, "Fixed denies"):
    // launchd agents and daemons, systemd units, drop-ins and session environment, XDG and KDE
    // autostart, the X session files. The crontab spools are SANDBOX_SYSTEM_WRITE_DENIES.
    ["library", "launchagents"],
    ["library", "launchdaemons"],
    [".config", "systemd"],
    [".local", "share", "systemd"],
    [".config", "environment.d"],
    [".config", "autostart"],
    [".config", "autostart-scripts"],
    [".config", "plasma-workspace", "env"],
    [".xprofile"],
    [".xsessionrc"],
  ].map((entry) => Object.freeze(entry)),
);

/**
 * Absolute system paths denied with everything beneath them, compared folded and anchored at `/`:
 * the crontab and at spools of Linux (`/var/spool/cron` in its `crontabs` and `tabs` layouts,
 * `/var/spool/at`) and macOS (`/private/var/at`, also spelled `/var/at`; `/usr/lib/cron/tabs` is a
 * link resolving there). Never protected move names: a project's own `at/` or `spool/` stays
 * ordinary.
 */
export const SANDBOX_SYSTEM_WRITE_DENIES: readonly string[] = Object.freeze([
  "/var/spool/cron",
  "/var/spool/at",
  "/private/var/at/tabs",
  "/private/var/at/jobs",
  "/var/at",
]);

/** Directories inside a gitdir whose whole subtree is writable (objects, refs, operation state). */
export const SANDBOX_GIT_ALLOWED_DIRECTORIES: readonly string[] = Object.freeze([
  "objects",
  "refs",
  "logs",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
]);

/** Entries directly in a gitdir that are writable, each also with a `.lock` suffix. */
export const SANDBOX_GIT_ALLOWED_FILES: readonly string[] = Object.freeze([
  "index",
  "head",
  "orig_head",
  "fetch_head",
  "merge_head",
  "merge_msg",
  "merge_mode",
  "merge_rr",
  "auto_merge",
  "cherry_pick_head",
  "revert_head",
  "rebase_head",
  "bisect_log",
  "bisect_start",
  "bisect_expected_rev",
  "bisect_ancestors_ok",
  "bisect_names",
  "bisect_terms",
  "packed-refs",
  "packed-refs.new",
  "merge_autostash",
  "commit_editmsg",
  "tag_editmsg",
  "squash_msg",
  "shallow",
  "description",
  "gc.pid",
  "gc.log",
  "info",
  "modules",
  "worktrees",
]);

/** Gitdir entries a submodule path must never be readable as. */
const GIT_DANGER = new Set(["config", "config.worktree", "commondir", "gitdir", "hooks", "info"]);

/**
 * For consumers that can only express denies as path patterns (the macOS runtime): the gitdir
 * internals that run or redirect code, denied at any depth below `.git`. Such a consumer cannot
 * express the allowlist or the `HEAD` rule exactly; see the rules above.
 */
export const SANDBOX_GIT_DENIED_INTERNALS: readonly string[] = Object.freeze([
  "config",
  "config.worktree",
  "commondir",
  "gitdir",
  "hooks",
  "info/attributes",
]);

/**
 * Names nothing leaves, and no directory is moved under, from outside: `.git` and the
 * single-component entries. A multi-component entry is guarded by its prefix rule instead (rule 4),
 * so its first component (`library`, `.config`) stays an ordinary name.
 */
export const SANDBOX_PROTECTED_PATH_NAMES: readonly string[] = Object.freeze([
  ".git",
  ...new Set(
    SANDBOX_MANDATORY_WRITE_DENIES.filter((entry) => entry.length === 1).map(
      (entry) => entry[0] as string,
    ),
  ),
]);

/** The multi-component entries and the anchored system paths, as folded name sequences. */
const PREFIX_GUARDED: readonly { readonly names: readonly string[]; readonly anchored: boolean }[] =
  [
    ...SANDBOX_MANDATORY_WRITE_DENIES.filter((entry) => entry.length > 1).map((names) => ({
      names,
      anchored: false,
    })),
    ...SANDBOX_SYSTEM_WRITE_DENIES.map((path) => ({
      names: path.split("/").filter((p) => p !== ""),
      anchored: true,
    })),
  ];

/**
 * Python's `str.casefold` where it differs from `toLowerCase` (full case folding, Unicode 15.1),
 * so both implementations fold identically: `ß`→`ss`, `ſ`→`s`, final sigma, Cherokee, ….
 */
const CASEFOLD_DIFF: Readonly<Record<number, string>> = Object.freeze({
  181: "\u03bc",
  223: "ss",
  329: "\u02bcn",
  383: "s",
  496: "j\u030c",
  837: "\u03b9",
  912: "\u03b9\u0308\u0301",
  944: "\u03c5\u0308\u0301",
  962: "\u03c3",
  976: "\u03b2",
  977: "\u03b8",
  981: "\u03c6",
  982: "\u03c0",
  1008: "\u03ba",
  1009: "\u03c1",
  1013: "\u03b5",
  1415: "\u0565\u0582",
  5024: "\u13a0",
  5025: "\u13a1",
  5026: "\u13a2",
  5027: "\u13a3",
  5028: "\u13a4",
  5029: "\u13a5",
  5030: "\u13a6",
  5031: "\u13a7",
  5032: "\u13a8",
  5033: "\u13a9",
  5034: "\u13aa",
  5035: "\u13ab",
  5036: "\u13ac",
  5037: "\u13ad",
  5038: "\u13ae",
  5039: "\u13af",
  5040: "\u13b0",
  5041: "\u13b1",
  5042: "\u13b2",
  5043: "\u13b3",
  5044: "\u13b4",
  5045: "\u13b5",
  5046: "\u13b6",
  5047: "\u13b7",
  5048: "\u13b8",
  5049: "\u13b9",
  5050: "\u13ba",
  5051: "\u13bb",
  5052: "\u13bc",
  5053: "\u13bd",
  5054: "\u13be",
  5055: "\u13bf",
  5056: "\u13c0",
  5057: "\u13c1",
  5058: "\u13c2",
  5059: "\u13c3",
  5060: "\u13c4",
  5061: "\u13c5",
  5062: "\u13c6",
  5063: "\u13c7",
  5064: "\u13c8",
  5065: "\u13c9",
  5066: "\u13ca",
  5067: "\u13cb",
  5068: "\u13cc",
  5069: "\u13cd",
  5070: "\u13ce",
  5071: "\u13cf",
  5072: "\u13d0",
  5073: "\u13d1",
  5074: "\u13d2",
  5075: "\u13d3",
  5076: "\u13d4",
  5077: "\u13d5",
  5078: "\u13d6",
  5079: "\u13d7",
  5080: "\u13d8",
  5081: "\u13d9",
  5082: "\u13da",
  5083: "\u13db",
  5084: "\u13dc",
  5085: "\u13dd",
  5086: "\u13de",
  5087: "\u13df",
  5088: "\u13e0",
  5089: "\u13e1",
  5090: "\u13e2",
  5091: "\u13e3",
  5092: "\u13e4",
  5093: "\u13e5",
  5094: "\u13e6",
  5095: "\u13e7",
  5096: "\u13e8",
  5097: "\u13e9",
  5098: "\u13ea",
  5099: "\u13eb",
  5100: "\u13ec",
  5101: "\u13ed",
  5102: "\u13ee",
  5103: "\u13ef",
  5104: "\u13f0",
  5105: "\u13f1",
  5106: "\u13f2",
  5107: "\u13f3",
  5108: "\u13f4",
  5109: "\u13f5",
  5112: "\u13f0",
  5113: "\u13f1",
  5114: "\u13f2",
  5115: "\u13f3",
  5116: "\u13f4",
  5117: "\u13f5",
  7296: "\u0432",
  7297: "\u0434",
  7298: "\u043e",
  7299: "\u0441",
  7300: "\u0442",
  7301: "\u0442",
  7302: "\u044a",
  7303: "\u0463",
  7304: "\ua64b",
  7830: "h\u0331",
  7831: "t\u0308",
  7832: "w\u030a",
  7833: "y\u030a",
  7834: "a\u02be",
  7835: "\u1e61",
  7838: "ss",
  8016: "\u03c5\u0313",
  8018: "\u03c5\u0313\u0300",
  8020: "\u03c5\u0313\u0301",
  8022: "\u03c5\u0313\u0342",
  8064: "\u1f00\u03b9",
  8065: "\u1f01\u03b9",
  8066: "\u1f02\u03b9",
  8067: "\u1f03\u03b9",
  8068: "\u1f04\u03b9",
  8069: "\u1f05\u03b9",
  8070: "\u1f06\u03b9",
  8071: "\u1f07\u03b9",
  8072: "\u1f00\u03b9",
  8073: "\u1f01\u03b9",
  8074: "\u1f02\u03b9",
  8075: "\u1f03\u03b9",
  8076: "\u1f04\u03b9",
  8077: "\u1f05\u03b9",
  8078: "\u1f06\u03b9",
  8079: "\u1f07\u03b9",
  8080: "\u1f20\u03b9",
  8081: "\u1f21\u03b9",
  8082: "\u1f22\u03b9",
  8083: "\u1f23\u03b9",
  8084: "\u1f24\u03b9",
  8085: "\u1f25\u03b9",
  8086: "\u1f26\u03b9",
  8087: "\u1f27\u03b9",
  8088: "\u1f20\u03b9",
  8089: "\u1f21\u03b9",
  8090: "\u1f22\u03b9",
  8091: "\u1f23\u03b9",
  8092: "\u1f24\u03b9",
  8093: "\u1f25\u03b9",
  8094: "\u1f26\u03b9",
  8095: "\u1f27\u03b9",
  8096: "\u1f60\u03b9",
  8097: "\u1f61\u03b9",
  8098: "\u1f62\u03b9",
  8099: "\u1f63\u03b9",
  8100: "\u1f64\u03b9",
  8101: "\u1f65\u03b9",
  8102: "\u1f66\u03b9",
  8103: "\u1f67\u03b9",
  8104: "\u1f60\u03b9",
  8105: "\u1f61\u03b9",
  8106: "\u1f62\u03b9",
  8107: "\u1f63\u03b9",
  8108: "\u1f64\u03b9",
  8109: "\u1f65\u03b9",
  8110: "\u1f66\u03b9",
  8111: "\u1f67\u03b9",
  8114: "\u1f70\u03b9",
  8115: "\u03b1\u03b9",
  8116: "\u03ac\u03b9",
  8118: "\u03b1\u0342",
  8119: "\u03b1\u0342\u03b9",
  8124: "\u03b1\u03b9",
  8126: "\u03b9",
  8130: "\u1f74\u03b9",
  8131: "\u03b7\u03b9",
  8132: "\u03ae\u03b9",
  8134: "\u03b7\u0342",
  8135: "\u03b7\u0342\u03b9",
  8140: "\u03b7\u03b9",
  8146: "\u03b9\u0308\u0300",
  8147: "\u03b9\u0308\u0301",
  8150: "\u03b9\u0342",
  8151: "\u03b9\u0308\u0342",
  8162: "\u03c5\u0308\u0300",
  8163: "\u03c5\u0308\u0301",
  8164: "\u03c1\u0313",
  8166: "\u03c5\u0342",
  8167: "\u03c5\u0308\u0342",
  8178: "\u1f7c\u03b9",
  8179: "\u03c9\u03b9",
  8180: "\u03ce\u03b9",
  8182: "\u03c9\u0342",
  8183: "\u03c9\u0342\u03b9",
  8188: "\u03c9\u03b9",
  43888: "\u13a0",
  43889: "\u13a1",
  43890: "\u13a2",
  43891: "\u13a3",
  43892: "\u13a4",
  43893: "\u13a5",
  43894: "\u13a6",
  43895: "\u13a7",
  43896: "\u13a8",
  43897: "\u13a9",
  43898: "\u13aa",
  43899: "\u13ab",
  43900: "\u13ac",
  43901: "\u13ad",
  43902: "\u13ae",
  43903: "\u13af",
  43904: "\u13b0",
  43905: "\u13b1",
  43906: "\u13b2",
  43907: "\u13b3",
  43908: "\u13b4",
  43909: "\u13b5",
  43910: "\u13b6",
  43911: "\u13b7",
  43912: "\u13b8",
  43913: "\u13b9",
  43914: "\u13ba",
  43915: "\u13bb",
  43916: "\u13bc",
  43917: "\u13bd",
  43918: "\u13be",
  43919: "\u13bf",
  43920: "\u13c0",
  43921: "\u13c1",
  43922: "\u13c2",
  43923: "\u13c3",
  43924: "\u13c4",
  43925: "\u13c5",
  43926: "\u13c6",
  43927: "\u13c7",
  43928: "\u13c8",
  43929: "\u13c9",
  43930: "\u13ca",
  43931: "\u13cb",
  43932: "\u13cc",
  43933: "\u13cd",
  43934: "\u13ce",
  43935: "\u13cf",
  43936: "\u13d0",
  43937: "\u13d1",
  43938: "\u13d2",
  43939: "\u13d3",
  43940: "\u13d4",
  43941: "\u13d5",
  43942: "\u13d6",
  43943: "\u13d7",
  43944: "\u13d8",
  43945: "\u13d9",
  43946: "\u13da",
  43947: "\u13db",
  43948: "\u13dc",
  43949: "\u13dd",
  43950: "\u13de",
  43951: "\u13df",
  43952: "\u13e0",
  43953: "\u13e1",
  43954: "\u13e2",
  43955: "\u13e3",
  43956: "\u13e4",
  43957: "\u13e5",
  43958: "\u13e6",
  43959: "\u13e7",
  43960: "\u13e8",
  43961: "\u13e9",
  43962: "\u13ea",
  43963: "\u13eb",
  43964: "\u13ec",
  43965: "\u13ed",
  43966: "\u13ee",
  43967: "\u13ef",
  64256: "ff",
  64257: "fi",
  64258: "fl",
  64259: "ffi",
  64260: "ffl",
  64261: "st",
  64262: "st",
  64275: "\u0574\u0576",
  64276: "\u0574\u0565",
  64277: "\u0574\u056b",
  64278: "\u057e\u0576",
  64279: "\u0574\u056d",
} as Record<number, string>);

/** NFKC, then full case folding: the same as Python's `normalize("NFKC", s).casefold()`. */
export function sandboxFoldName(name: string): string {
  let out = "";
  for (const ch of name.normalize("NFKC"))
    out += CASEFOLD_DIFF[ch.codePointAt(0) as number] ?? ch.toLowerCase();
  return out;
}
const fold = sandboxFoldName;
const parts = (path: string) =>
  path
    .split("/")
    .filter((part) => part !== "")
    .map(fold);

/**
 * Whether `prefix` (below the allowlisted directory `head`) is a directory where git itself keeps
 * a `HEAD`: `logs/HEAD`, `logs/refs/remotes/<r>/HEAD`, `refs/remotes/<r>/HEAD`, `sequencer/head`.
 */
function holdsHead(head: string, prefix: readonly string[]): boolean {
  if (head === "logs")
    return (
      prefix.length === 0 ||
      (prefix.length === 3 && prefix[0] === "refs" && prefix[1] === "remotes")
    );
  if (head === "refs") return prefix.length === 2 && prefix[0] === "remotes";
  return head === "sequencer" && prefix.length === 0;
}

/**
 * Inside an allowlisted subtree no repository can be forged: no `.git` component, no `HEAD`
 * except where git keeps one, and next to such a `HEAD` no `objects`, `commondir` or `gitdir`
 * (what git needs beside a `HEAD` to take a directory for a gitdir).
 */
function subtreeAllowed(head: string, rest: readonly string[]): boolean {
  return rest.every((name, k) => {
    if (name === ".git") return false;
    if (name === "head") return k === rest.length - 1 && holdsHead(head, rest.slice(0, k));
    if (["objects", "commondir", "gitdir"].includes(name))
      return !holdsHead(head, rest.slice(0, k));
    return true;
  });
}

function gitInternalAllowed(rel: readonly string[]): boolean {
  if (rel.length === 0) return true;
  const head = rel[0] as string;
  if (SANDBOX_GIT_ALLOWED_DIRECTORIES.includes(head)) return subtreeAllowed(head, rel.slice(1));
  if ((head === "modules" || head === "worktrees") && rel.length > 1) {
    const rest = rel.slice(1);
    if (head === "worktrees") return gitInternalAllowed(rest.slice(1));
    const readings = rest.map((_, k) => rest.slice(k + 1));
    if (
      readings.some((r) => r.length > 0 && GIT_DANGER.has(r[0] as string) && !gitInternalAllowed(r))
    )
      return false;
    return readings.some((r) => r.length > 0 && gitInternalAllowed(r));
  }
  if (rel.length === 1) {
    const base = head.endsWith(".lock") ? head.slice(0, -5) : head;
    // git stash's temporary index: index.stash.<pid>
    return SANDBOX_GIT_ALLOWED_FILES.includes(base) || /^index\.stash\.[0-9]+$/.test(base);
  }
  return (
    head === "info" && rel.length === 2 && ["exclude", "exclude.lock"].includes(rel[1] as string)
  );
}

/** Whether restricted execution may never write `path` (an absolute, normalized path). */
export function isSandboxWriteDenied(path: string): boolean {
  const names = parts(path);
  for (const system of SANDBOX_SYSTEM_WRITE_DENIES) {
    const anchored = parts(system);
    if (anchored.every((name, j) => names[j] === name)) return true;
  }
  for (const entry of SANDBOX_MANDATORY_WRITE_DENIES)
    for (let i = 0; i + entry.length <= names.length; i++)
      if (entry.every((name, j) => names[i + j] === name)) return true;
  const git = names.indexOf(".git");
  if (git >= 0) return !gitInternalAllowed(names.slice(git + 1));
  return names[names.length - 1] === "head";
}

/**
 * The next components a moved entry must not bring to `to`: for each guarded sequence whose proper
 * prefix `to` ends in (anchored: equals), the component that follows. Empty when `to` is no prefix.
 */
function prefixNext(to: readonly string[]): string[] {
  const next: string[] = [];
  for (const { names, anchored } of PREFIX_GUARDED)
    for (let k = 1; k < names.length; k++) {
      if (anchored && to.length !== k) continue;
      if (to.length < k) continue;
      if (names.slice(0, k).every((name, j) => to[to.length - k + j] === name))
        next.push(names[k] as string);
    }
  return next;
}

/**
 * Whether a restricted rename or link of `source` to `destination` is refused (rule 4).
 * `sourceEntries` are the names directly in a moved directory; the check needs them only when the
 * destination ends in a proper prefix of a guarded entry, and without them it refuses.
 */
export function isSandboxMoveDenied(
  source: string,
  destination: string,
  sourceIsDirectory: boolean,
  sourceEntries?: readonly string[],
): boolean {
  if (isSandboxWriteDenied(source) || isSandboxWriteDenied(destination)) return true;
  const from = parts(source);
  const to = parts(destination);
  const next = prefixNext(to);
  if (next.length > 0) {
    if (!sourceIsDirectory || sourceEntries === undefined) return true;
    if (sourceEntries.some((name) => next.includes(fold(name)))) return true;
  }
  const protectedAt = (names: string[]) =>
    names.findIndex((n) => SANDBOX_PROTECTED_PATH_NAMES.includes(n));
  const i = protectedAt(from);
  const samePrefix = (n: number) =>
    n >= 0 && to.length > n + 1 && from.slice(0, n + 1).every((name, k) => to[k] === name);
  if (i >= 0 && !samePrefix(i)) return true;
  const j = protectedAt(to);
  if (sourceIsDirectory && j >= 0 && !(i === j && samePrefix(j))) return true;
  return !sourceIsDirectory && to[to.length - 1] === ".git";
}

/**
 * The same policy for the Python consumers (`linux-sandbox.py`, `native-files.py`): defines
 * `write_denied(path)` and `move_denied(source, destination, is_dir)` with identical rules.
 */
export const SANDBOX_WRITE_POLICY_PYTHON: string = `
import unicodedata as _unicodedata
WRITE_DENIES = [[_unicodedata.normalize("NFKC", n).casefold() for n in e] for e in ${JSON.stringify(SANDBOX_MANDATORY_WRITE_DENIES)}]
SYSTEM_WRITE_DENIES = [[_unicodedata.normalize("NFKC", n).casefold() for n in p.split("/") if n] for p in ${JSON.stringify(SANDBOX_SYSTEM_WRITE_DENIES)}]
PREFIX_GUARDED = [(e, False) for e in WRITE_DENIES if len(e) > 1] + [(e, True) for e in SYSTEM_WRITE_DENIES]
GIT_ALLOWED_DIRECTORIES = set(${JSON.stringify(SANDBOX_GIT_ALLOWED_DIRECTORIES)})
GIT_ALLOWED_FILES = set(${JSON.stringify(SANDBOX_GIT_ALLOWED_FILES)})
GIT_DANGER = set(${JSON.stringify([...GIT_DANGER])})
PROTECTED_PATH_NAMES = set(${JSON.stringify(SANDBOX_PROTECTED_PATH_NAMES)})


def _fold_parts(path):
    return [_unicodedata.normalize("NFKC", p).casefold() for p in path.split("/") if p]


def _holds_head(head, prefix):
    if head == "logs":
        return not prefix or (len(prefix) == 3 and prefix[0] == "refs" and prefix[1] == "remotes")
    if head == "refs":
        return len(prefix) == 2 and prefix[0] == "remotes"
    return head == "sequencer" and not prefix


def _subtree_allowed(head, rest):
    for k, name in enumerate(rest):
        if name == ".git":
            return False
        if name == "head" and not (k == len(rest) - 1 and _holds_head(head, rest[:k])):
            return False
        if name in ("objects", "commondir", "gitdir") and _holds_head(head, rest[:k]):
            return False
    return True


def _git_internal_allowed(rel):
    if not rel:
        return True
    head = rel[0]
    if head in GIT_ALLOWED_DIRECTORIES:
        return _subtree_allowed(head, rel[1:])
    if head in ("modules", "worktrees") and len(rel) > 1:
        rest = rel[1:]
        if head == "worktrees":
            return _git_internal_allowed(rest[1:])
        readings = [rest[k + 1:] for k in range(len(rest))]
        if any(r and r[0] in GIT_DANGER and not _git_internal_allowed(r) for r in readings):
            return False
        return any(r and _git_internal_allowed(r) for r in readings)
    if len(rel) == 1:
        base = head[:-5] if head.endswith(".lock") else head
        stash = base.startswith("index.stash.") and base[12:].isascii() and base[12:].isdigit()
        return base in GIT_ALLOWED_FILES or stash
    return head == "info" and len(rel) == 2 and rel[1] in ("exclude", "exclude.lock")


def write_denied(path):
    names = _fold_parts(path)
    for system in SYSTEM_WRITE_DENIES:
        if names[:len(system)] == system:
            return True
    for entry in WRITE_DENIES:
        for i in range(len(names) - len(entry) + 1):
            if names[i:i + len(entry)] == entry:
                return True
    if ".git" in names:
        return not _git_internal_allowed(names[names.index(".git") + 1:])
    return bool(names) and names[-1] == "head"


def _prefix_next(dst):
    nxt = []
    for names, anchored in PREFIX_GUARDED:
        for k in range(1, len(names)):
            if (anchored and len(dst) != k) or len(dst) < k:
                continue
            if dst[len(dst) - k:] == names[:k]:
                nxt.append(names[k])
    return nxt


def move_denied(source, destination, is_dir, entries=None):
    if write_denied(source) or write_denied(destination):
        return True
    src, dst = _fold_parts(source), _fold_parts(destination)
    nxt = _prefix_next(dst)
    if nxt:
        if not is_dir:
            return True
        if entries is None:
            # no entries given: list the source path itself, refusing what cannot be listed
            try:
                import os as _os
                entries = _os.listdir(source)
            except OSError:
                return True
        if any(_unicodedata.normalize("NFKC", n).casefold() in nxt for n in entries):
            return True

    def protected_at(names):
        return next((k for k, n in enumerate(names) if n in PROTECTED_PATH_NAMES), -1)

    def same_prefix(n):
        return n >= 0 and len(dst) > n + 1 and dst[:n + 1] == src[:n + 1]
    i = protected_at(src)
    if i >= 0 and not same_prefix(i):
        return True
    j = protected_at(dst)
    if is_dir and j >= 0 and not (i == j and same_prefix(j)):
        return True
    return (not is_dir) and bool(dst) and dst[-1] == ".git"
`;
