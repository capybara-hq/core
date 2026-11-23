import { accessSync, constants, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { fsNameBytes, fsNameString } from "./fs-names.js";
import { within } from "./operation-types.js";

export { fsNameBytes, fsNameString };

/** The most read roots (directories and files together) a carve may hand to Landlock (one rule each). */
export const MAX_CARVED_READ_ROOTS = 4096;

export interface CarveFs {
  readdir(path: string): string[];
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean };
  /** Whether the process can enter and list a directory (R_OK | X_OK). */
  canOpen(path: string): boolean;
  /** Whether the process can open a regular file for reading (R_OK). */
  canRead(path: string): boolean;
}

/** What a carve grants: whole directories, and exact regular files read without their directory. */
export interface CarvedReadRoots {
  roots: string[];
  files: string[];
}

/**
 * Whether the SDK launcher accepts `path` as a root (its `valid_path`), conservatively: one it
 * would refuse fails the whole launch, so such a directory is skipped (left unreadable) instead.
 */
export function launcherAcceptsRoot(path: string): boolean {
  // the launcher counts UTF-16 bytes (8192), i.e. 4096 code units
  if (path.length > 4096 || path.includes("\\") || path.includes("//")) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false; // control characters
  }
  for (const part of path.split("/")) {
    if (/%2f|%5c/i.test(part) || part.replace(/%2e/gi, ".") === "..") return false;
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {}
    if (decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false;
  }
  return true;
}

/**
 * This host's file system: names read as bytes ({@link fsNameString}), entries the launcher
 * would refuse as roots left out, and each entry's type taken from its directory listing, so a
 * listed entry needs no lstat of its own.
 */
function nodeFs(): CarveFs {
  const listed = new Map<string, { dir: boolean; link: boolean; file: boolean }>();
  return {
    readdir: (path) => {
      const names: string[] = [];
      for (const entry of readdirSync(fsNameBytes(path), {
        withFileTypes: true,
        encoding: "buffer",
      })) {
        const name = fsNameString(entry.name);
        const child = join(path, name);
        if (!launcherAcceptsRoot(child)) continue;
        listed.set(child, {
          dir: entry.isDirectory(),
          link: entry.isSymbolicLink(),
          file: entry.isFile(),
        });
        names.push(name);
      }
      return names;
    },
    lstat: (path) => {
      const known = listed.get(path);
      if (known)
        return {
          isDirectory: () => known.dir,
          isSymbolicLink: () => known.link,
          isFile: () => known.file,
        };
      return lstatSync(fsNameBytes(path));
    },
    canOpen: (path) => {
      try {
        accessSync(fsNameBytes(path), constants.R_OK | constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    canRead: (path) => {
      try {
        accessSync(fsNameBytes(path), constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function clean(path: string): string {
  if (!isAbsolute(path)) {
    throw new SandboxScopeDeniedError(
      `read carve needs absolute paths, got ${JSON.stringify(path)}`,
    );
  }
  const n = normalize(path);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * Landlock only grants: each read root containing a denied path is replaced by what lies beside
 * the denied paths, recursively along their ancestors. In each directory it expands, the carve
 * keeps every real subdirectory off every denied path whole (as a root, or expanded again when it
 * holds one), and grants every regular file directly inside it that is not denied as an exact
 * file root (`files`: read without listing its directory; the agent pins each no-follow and
 * grants nothing for one that changed type or has a second name). Symbolic links, other file
 * types, and entries the process cannot open (directories R_OK|X_OK, files R_OK) are skipped; a
 * root inside a denied path is dropped; a root clear of every denied path is kept as is.
 *
 * Budget: directories alone above MAX_CARVED_READ_ROOTS throw SandboxScopeDeniedError; files
 * fill what the directories leave of it, in code-point order, and the rest are dropped, which only
 * leaves those files unreadable (the agent drops more when its open-file limit is lower).
 *
 * Only the denied paths' ancestors are expanded; their other children are kept whole. A denied
 * path that does not exist still carves its existing ancestors, so creating it later grants
 * nothing. The walk follows real names only (lstat), so a denied path matters here in its
 * canonical form: the caller passes the given and canonical forms (`withCanonicalForms`). Every
 * comparison with a denied path is also made case-insensitively (both sides `toLowerCase()`, a
 * Unicode lowering), so on a case-folding directory a denied `~/.ssh` present as `~/.SSH` is
 * neither granted whole nor as a file; on a case-sensitive one this only expands or drops a
 * little more. A root that must be expanded but is itself a symbolic link is dropped, since its
 * target's real names would never match a denied path. The default file system leaves out names
 * the launcher would refuse as roots ({@link launcherAcceptsRoot}) and reads names as bytes
 * ({@link fsNameString}).
 */
export function carveReadRoots(
  readRoots: readonly string[],
  denied: readonly string[],
  fs: CarveFs = nodeFs(),
): CarvedReadRoots {
  const deniedPaths = [...new Set(denied.map(clean))];
  const deniedFolded = [...new Set(deniedPaths.map((d) => d.toLowerCase()))];
  // path lies inside or equals a denied path, in any given form or ignoring case
  const insideDenied = (path: string) => {
    if (deniedPaths.some((d) => within(path, d))) return true;
    const folded = path.toLowerCase();
    return deniedFolded.some((d) => within(folded, d));
  };
  // a denied path lies inside or equals path, likewise
  const holdsDenied = (path: string) => {
    if (deniedPaths.some((d) => within(d, path))) return true;
    const folded = path.toLowerCase();
    return deniedFolded.some((d) => within(d, folded));
  };
  const out = new Set<string>();
  const files: string[] = [];

  const add = (root: string) => {
    out.add(root);
    if (out.size > MAX_CARVED_READ_ROOTS) {
      throw new SandboxScopeDeniedError(
        `reading the whole machine minus the denied paths needs more than ${MAX_CARVED_READ_ROOTS} ` +
          "Landlock rules on this device; limit project reach to listed paths with " +
          "`capybara-device ceiling set --project-reach paths`",
      );
    }
  };
  const addFile = (file: string) => {
    if (insideDenied(file) || holdsDenied(file)) return;
    // never more than could be granted: the final cut happens once the directories are known
    if (files.length < MAX_CARVED_READ_ROOTS) files.push(file);
  };

  const carve = (root: string, top: boolean) => {
    if (insideDenied(root)) return;
    if (!holdsDenied(root)) {
      add(root);
      return;
    }
    if (top) {
      // A given root is checked here; a child was already checked by its parent's walk.
      try {
        const st = fs.lstat(root);
        if (st.isSymbolicLink() || !st.isDirectory()) return;
      } catch {
        return;
      }
    }
    let entries: string[];
    try {
      entries = fs.readdir(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(root, entry);
      let st: ReturnType<CarveFs["lstat"]>;
      try {
        st = fs.lstat(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (fs.canOpen(child)) carve(child, false);
      } else if (st.isFile()) {
        if (fs.canRead(child)) addFile(child);
      }
    }
  };

  for (const root of new Set(readRoots.map(clean))) carve(root, true);
  const sorted = (list: Iterable<string>) =>
    [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const budget = MAX_CARVED_READ_ROOTS - out.size;
  // No file lies under a granted directory: files come only from directories that hold a denied
  // path, and neither those nor their ancestors are ever granted whole.
  return { roots: sorted(out), files: sorted(files).slice(0, budget) };
}
