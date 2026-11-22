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

const nodeFs: CarveFs = {
  readdir: (path) => readdirSync(path),
  lstat: (path) => lstatSync(path),
  canOpen: (path) => {
    try {
      accessSync(path, constants.R_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

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
 * would never match a denied path. Residual: a file directly inside a directory on the path to a
 * denied one is not readable (only directories are granted beside the denied path).
 */
export function carveReadRoots(
  readRoots: readonly string[],
  denied: readonly string[],
  fs: CarveFs = nodeFs,
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
