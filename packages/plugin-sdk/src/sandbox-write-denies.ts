/**
 * What restricted execution may never write inside a granted root: one policy for every consumer
 * (the Linux launcher's broker, `native-files.py`, the device agent and, as far as its glob
 * patterns can express it, the macOS runtime). It keeps a later unsandboxed tool run by the owner
 * from executing what a restricted command left behind.
 *
 * 1. {@link SANDBOX_MANDATORY_WRITE_DENIES}: component sequences denied wherever they appear (the
 *    entry and everything beneath it): shell startup files, git's global files, direnv and npm
 *    configuration, editor and agent configuration.
 * 2. Inside a `.git` directory (the first `.git` component of a path) only git's ordinary
 *    internals are writable, an allowlist ({@link SANDBOX_GIT_ALLOWED_DIRECTORIES},
 *    {@link SANDBOX_GIT_ALLOWED_FILES}, `info/exclude`). Everything else there is denied:
 *    `config`, `config.worktree`, `commondir`, `gitdir`, `hooks/**`, `info/attributes`, unknown
 *    names. The gitdirs of submodules (`modules/<name>/`, where a name may contain `/`) and
 *    worktrees (`worktrees/<name>/`) follow the same allowlist; a submodule path is refused when
 *    any reading of its name would make it a denied internal.
 * 3. Outside `.git`, a file named `HEAD` is denied: with `objects/` and `refs/` it would make a
 *    bare-repository lookalike whose configuration git honours.
 * 4. Moves ({@link isSandboxMoveDenied}): nothing leaves a protected name (`.git`, `.claude`, …)
 *    except within the same protected directory; a directory is not moved under a protected name
 *    from outside it; no non-directory becomes `.git` (a `gitdir:` pointer).
 *
 * Names are compared after Unicode NFKC normalization and case folding. Known limitations: a
 * restricted command cannot `git init`, add a submodule or worktree, or create a bare repository;
 * continuing an operation it started (`git rebase --continue`) runs the todo list it wrote, like
 * any script it wrote; files that tools execute by convention without configuration (for example
 * `package.json` scripts) are not covered. The macOS runtime's glob patterns cannot express the
 * gitdir allowlist, the `HEAD` rule or moving a nested repository's `.git` away; it denies
 * {@link SANDBOX_GIT_DENIED_INTERNALS} at any depth instead.
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
  ].map((entry) => Object.freeze(entry)),
);

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

/** Names nothing leaves, and no directory is moved under, from outside. */
export const SANDBOX_PROTECTED_PATH_NAMES: readonly string[] = Object.freeze([
  ".git",
  ...new Set(SANDBOX_MANDATORY_WRITE_DENIES.map((entry) => entry[0] as string)),
]);

const fold = (name: string) => name.normalize("NFKC").toLowerCase();
const parts = (path: string) =>
  path
    .split("/")
    .filter((part) => part !== "")
    .map(fold);

function gitInternalAllowed(rel: readonly string[]): boolean {
  if (rel.length === 0) return true;
  const head = rel[0] as string;
  if (SANDBOX_GIT_ALLOWED_DIRECTORIES.includes(head)) return true;
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
    return SANDBOX_GIT_ALLOWED_FILES.includes(base);
  }
  return (
    head === "info" && rel.length === 2 && ["exclude", "exclude.lock"].includes(rel[1] as string)
  );
}

/** Whether restricted execution may never write `path` (an absolute, normalized path). */
export function isSandboxWriteDenied(path: string): boolean {
  const names = parts(path);
  for (const entry of SANDBOX_MANDATORY_WRITE_DENIES)
    for (let i = 0; i + entry.length <= names.length; i++)
      if (entry.every((name, j) => names[i + j] === name)) return true;
  const git = names.indexOf(".git");
  if (git >= 0) return !gitInternalAllowed(names.slice(git + 1));
  return names[names.length - 1] === "head";
}

/** Whether a restricted rename or link of `source` to `destination` is refused (rule 4). */
export function isSandboxMoveDenied(
  source: string,
  destination: string,
  sourceIsDirectory: boolean,
): boolean {
  const from = parts(source);
  const to = parts(destination);
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
GIT_ALLOWED_DIRECTORIES = set(${JSON.stringify(SANDBOX_GIT_ALLOWED_DIRECTORIES)})
GIT_ALLOWED_FILES = set(${JSON.stringify(SANDBOX_GIT_ALLOWED_FILES)})
GIT_DANGER = set(${JSON.stringify([...GIT_DANGER])})
PROTECTED_PATH_NAMES = set(${JSON.stringify(SANDBOX_PROTECTED_PATH_NAMES)})


def _fold_parts(path):
    return [_unicodedata.normalize("NFKC", p).casefold() for p in path.split("/") if p]


def _git_internal_allowed(rel):
    if not rel:
        return True
    head = rel[0]
    if head in GIT_ALLOWED_DIRECTORIES:
        return True
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
        return base in GIT_ALLOWED_FILES
    return head == "info" and len(rel) == 2 and rel[1] in ("exclude", "exclude.lock")


def write_denied(path):
    names = _fold_parts(path)
    for entry in WRITE_DENIES:
        for i in range(len(names) - len(entry) + 1):
            if names[i:i + len(entry)] == entry:
                return True
    if ".git" in names:
        return not _git_internal_allowed(names[names.index(".git") + 1:])
    return bool(names) and names[-1] == "head"


def move_denied(source, destination, is_dir):
    src, dst = _fold_parts(source), _fold_parts(destination)

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
