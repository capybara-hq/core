/**
 * Paths restricted execution may never write inside a granted root, at any depth: git
 * configuration and hooks (a later unsandboxed `git` there would run what a command left), shell
 * startup files, and editor and agent configuration. One source for every consumer: the Linux
 * launcher's broker (`linux-sandbox.py`), the device's native helper checks and the macOS
 * runtime's write denies.
 *
 * Each entry is a sequence of path components; a path is denied when that sequence appears in it
 * consecutively (compared case-insensitively), so the entry itself and everything beneath it are
 * covered. A restricted command also may not create a non-directory named `.git` (a `gitdir:`
 * pointer to configuration it wrote elsewhere), nor move a directory to a path containing one of
 * {@link SANDBOX_PROTECTED_PATH_NAMES}.
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
    [".vscode"],
    [".idea"],
    [".claude", "commands"],
    [".claude", "agents"],
    [".git", "hooks"],
    [".git", "config"],
    [".git", "config.worktree"],
    [".git", "commondir"],
  ].map((entry) => Object.freeze(entry)),
);

/** The first component of every deny entry, plus `.git`: names a moved directory may not take. */
export const SANDBOX_PROTECTED_PATH_NAMES: readonly string[] = Object.freeze([
  ...new Set([".git", ...SANDBOX_MANDATORY_WRITE_DENIES.map((entry) => entry[0] as string)]),
]);

/** Whether restricted execution may never write `path` (an absolute, normalized path). */
export function isSandboxWriteDenied(path: string): boolean {
  const parts = path
    .split("/")
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase());
  return SANDBOX_MANDATORY_WRITE_DENIES.some((entry) => {
    for (let i = 0; i + entry.length <= parts.length; i++)
      if (entry.every((name, j) => parts[i + j] === name)) return true;
    return false;
  });
}
