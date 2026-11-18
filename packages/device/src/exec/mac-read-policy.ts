import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

/**
 * What a restricted macOS command may read (Seatbelt through the patched sandbox runtime): every
 * read is denied from `/` down, then these come back. Nothing else is readable, the ancestors of
 * the granted roots included: Seatbelt lets a command stat any directory (the runtime's
 * `file-read-metadata` on directories), which is all traversal, `cd`, `getcwd` and git's
 * repository discovery need, and a directory's listing or a file beside a grant stays unreadable.
 *
 * `MAC_SYSTEM_READ_ROOTS` are read whole (`(subpath …)`); like the Linux launcher's system roots
 * (`/usr`, `/bin`, `/sbin`, `/lib`, `/etc`, `/proc`), they hold the OS, the developer tools and
 * the package managers' installs, and no user data:
 * - `/System`, `/usr` (with `/usr/local`, Intel Homebrew), `/bin`, `/sbin`: the OS, its shells and
 *   tools, the dyld shared cache (under `/System/Volumes/Preboot/Cryptexes`);
 * - `/opt/homebrew`: Homebrew on Apple silicon;
 * - `/Applications/Xcode.app`, `/Library/Developer`: Xcode and the Command Line Tools, which
 *   `/usr/bin/cc`, `git` and `python3` shims run;
 * - `/Library/Apple`: Apple's system content outside the sealed volume (`MobileDevice`, which
 *   the Xcode tools load, Rosetta, `/Library/Apple/usr/bin` on the default PATH);
 * - `/Library/Frameworks`: framework installs such as python.org's Python;
 * - `/Library/Java/JavaVirtualMachines`: installed JDKs;
 * - `/private/etc`: shell startup (`/etc/profile`, `/etc/zshrc`), `paths`, `hosts`, `ssl` (the
 *   OpenSSL config and CA bundle), `localtime`; root-only files there stay protected by their
 *   modes;
 * - `/private/var/db/timezone`: the zoneinfo `/etc/localtime` points into;
 * - `/private/var/select`: `xcode-select`'s developer directory link the shims read;
 * - `/dev/fd`: the descriptors a command already holds (`<(…)`, `/dev/stdin`).
 */
export const MAC_SYSTEM_READ_ROOTS: readonly string[] = Object.freeze([
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/opt/homebrew",
  "/Applications/Xcode.app",
  "/Library/Developer",
  "/Library/Apple",
  "/Library/Frameworks",
  "/Library/Java/JavaVirtualMachines",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/select",
  "/dev/fd",
]);

/**
 * Exact system paths (`(literal …)`): the root's links (`/tmp`, `/var`, `/etc`), which a path
 * spelled through them must read to follow; the Command Line Tools' `xcode-select` link and
 * Xcode's license acceptance, without which the `cc` / `make` / `python3` shims refuse to run; the
 * character devices a command reads (`/dev/null` is already the runtime's).
 */
export const MAC_SYSTEM_READ_EXACT: readonly string[] = Object.freeze([
  "/tmp",
  "/var",
  "/etc",
  "/private/var/db/xcode_select_link",
  "/Library/Preferences/com.apple.dt.Xcode.plist",
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/dtracehelper",
]);

const inside = (path: string, root: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/**
 * The read allows of one restricted macOS operation. `roots` (the grant's read and write roots,
 * the tool-home directories) are read whole; `exact` (the staged helper, the Java agent, the
 * tool-home files, a native root's pinned missing directories) exactly, as the caller chose them:
 * a file's bytes, or a directory's entries and nothing below it. Of the ancestors of both only the
 * symbolic links are added, exactly, so a path spelled through a link resolves; a directory
 * ancestor needs nothing. A link at or under a denied read root is never added.
 */
export function macReadAllows(input: {
  roots: readonly string[];
  exact: readonly string[];
  deniedReadRoots: readonly string[];
  /**
   * The user's canonical temporary directory (`DARWIN_USER_TEMP_DIR`): only its `xcrun_db`, the
   * tool lookup cache the `xcrun` shims read, is added, exactly (without it every `cc` runs
   * `xcodebuild -find` again and prints its warnings).
   */
  userTempDir?: string | undefined;
  /** Test seam: whether a path is a symbolic link (lstat, never following it). */
  isSymlink?: (path: string) => boolean;
}): { allowRead: string[]; allowReadExact: string[] } {
  const isSymlink =
    input.isSymlink ??
    ((path: string) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    });
  const exact = new Set(MAC_SYSTEM_READ_EXACT);
  const clean = (path: string) => normalize(path).replace(/(.)\/+$/, "$1");
  for (const path of input.exact) if (isAbsolute(path)) exact.add(clean(path));
  if (input.userTempDir && isAbsolute(input.userTempDir))
    exact.add(join(clean(input.userTempDir), "xcrun_db"));
  for (const path of [...input.roots, ...input.exact]) {
    if (!isAbsolute(path)) continue;
    for (let p = dirname(clean(path)); p !== "/"; p = dirname(p))
      if (isSymlink(p) && !input.deniedReadRoots.some((d) => inside(p, d))) exact.add(p);
  }
  return {
    allowRead: [...new Set([...MAC_SYSTEM_READ_ROOTS, ...input.roots])],
    allowReadExact: [...exact],
  };
}
