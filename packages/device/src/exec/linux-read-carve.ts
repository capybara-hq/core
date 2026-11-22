import { accessSync, constants, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { within } from "./operation-types.js";

/** The most read roots a carve may hand to Landlock (one rule each). */
export const MAX_CARVED_READ_ROOTS = 4096;

export interface CarveFs {
  readdir(path: string): string[];
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  canOpen(path: string): boolean;
}

/**
 * A file name's bytes as the agent (Python, "surrogateescape") reads them: UTF-8, with each byte
 * outside a well-formed sequence as U+DC80–U+DCFF. JSON carries such a string to the agent, which
 * opens exactly the original bytes, so a directory whose name is not UTF-8 is granted, not lost.
 */
export function fsNameString(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    const n =
      b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let ok = n > 0 && i + n <= bytes.length;
    for (let k = 1; ok && k < n; k++) ok = ((bytes[i + k] as number) & 0xc0) === 0x80;
    if (ok) {
      const c = bytes[i + 1] as number;
      // no overlong forms, no encoded surrogates, nothing above U+10FFFF
      ok = !(
        (b === 0xe0 && c < 0xa0) ||
        (b === 0xed && c > 0x9f) ||
        (b === 0xf0 && c < 0x90) ||
        (b === 0xf4 && c > 0x8f)
      );
    }
    if (ok) {
      out += Buffer.from(bytes.subarray(i, i + n)).toString("utf8");
      i += n;
    } else {
      out += String.fromCharCode(0xdc00 + b);
      i++;
    }
  }
  return out;
}

/** The bytes {@link fsNameString} read (its inverse). */
export function fsNameBytes(name: string): Buffer {
  const parts: Buffer[] = [];
  let run = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const next = name.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      run += name.slice(i, i + 2); // a pair, whatever its low half
      i++;
    } else if (c >= 0xdc80 && c <= 0xdcff) {
      parts.push(Buffer.from(run, "utf8"), Buffer.of(c - 0xdc00));
      run = "";
    } else run += name[i];
  }
  parts.push(Buffer.from(run, "utf8"));
  return Buffer.concat(parts);
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
  const listed = new Map<string, { dir: boolean; link: boolean }>();
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
        listed.set(child, { dir: entry.isDirectory(), link: entry.isSymbolicLink() });
        names.push(name);
      }
      return names;
    },
    lstat: (path) => {
      const known = listed.get(path);
      if (known) return { isDirectory: () => known.dir, isSymbolicLink: () => known.link };
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
 * Landlock only grants: each read root containing a denied path is replaced by the real
 * directories beneath it that lie off every denied path, recursively along the denied paths'
 * ancestors. Symbolic links, non-directories and entries the process cannot open (R_OK|X_OK)
 * are skipped; a root inside a denied path is dropped; a root clear of every denied path is kept
 * as is. Throws SandboxScopeDeniedError above MAX_CARVED_READ_ROOTS.
 *
 * Only the denied paths' ancestors are expanded; their other children are kept whole. A denied
 * path that does not exist still carves its existing ancestors, so creating it later grants
 * nothing. The walk follows real names only (lstat), so a denied path matters here in its
 * canonical form: the caller passes the given and canonical forms (`withCanonicalForms`). A root
 * that must be expanded but is itself a symbolic link is dropped, since its target's real names
 * would never match a denied path. The default file system leaves out names the launcher would
 * refuse as roots ({@link launcherAcceptsRoot}) and reads names as bytes ({@link fsNameString}).
 * Residual: a file directly inside a directory on the path to a denied one is not readable (only
 * directories are granted beside the denied path).
 */
export function carveReadRoots(
  readRoots: readonly string[],
  denied: readonly string[],
  fs: CarveFs = nodeFs(),
): string[] {
  const deniedPaths = [...new Set(denied.map(clean))];
  const out = new Set<string>();

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

  const carve = (root: string, top: boolean) => {
    if (deniedPaths.some((d) => within(root, d))) return; // inside or equal to a denied path
    if (!deniedPaths.some((d) => within(d, root))) {
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
      try {
        const st = fs.lstat(child);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
      } catch {
        continue;
      }
      if (!fs.canOpen(child)) continue;
      carve(child, false);
    }
  };

  for (const root of new Set(readRoots.map(clean))) carve(root, true);
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
