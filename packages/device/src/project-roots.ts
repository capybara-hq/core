import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { validateSandboxPathShape } from "@capybara-hq/plugin-sdk";
import { MAX_DEVICE_SHARED_PROJECT_ROOTS } from "@capybara-hq/plugin-sdk/device-protocol";
import { connectionsDir, DEVICE_ID_PATTERN } from "./connections.js";
import { credentialPath, writePrivate } from "./state.js";

/**
 * The project directories one connection has used (`<connection dir>/projects.json`): the project
 * root of every admitted operation, most recent first. Other connections of the machine read it
 * only to learn which directories they share; nothing here is ever sent with another connection's
 * name.
 */
export const PROJECT_ROOTS_MAX = MAX_DEVICE_SHARED_PROJECT_ROOTS;
const PROJECT_ROOTS_VERSION = 1;

export function projectRootsPath(connectionStateDir: string): string {
  return join(connectionStateDir, "projects.json");
}

/** The largest projects.json read: every root at the longest path, with slack. */
const PROJECT_ROOTS_FILE_MAX_BYTES = PROJECT_ROOTS_MAX * 4200 + 1024;

/**
 * The file's text: never through a symlink, never a FIFO or other non-regular file (no blocking
 * read on the program's event loop), never more than {@link PROJECT_ROOTS_FILE_MAX_BYTES}.
 */
function readBounded(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > PROJECT_ROOTS_FILE_MAX_BYTES)
      throw new Error(`${file} is not a bounded regular file`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const isRoot = (v: unknown): v is string =>
  typeof v === "string" && validateSandboxPathShape(v).length === 0;

/** The recorded roots, most recent first; [] when the file is absent or invalid. */
export function readProjectRoots(connectionStateDir: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readBounded(projectRootsPath(connectionStateDir)));
  } catch {
    return [];
  }
  const file = raw as { version?: unknown; roots?: unknown } | null;
  if (file?.version !== PROJECT_ROOTS_VERSION || !Array.isArray(file.roots)) return [];
  return [...new Set(file.roots.filter(isRoot))].slice(0, PROJECT_ROOTS_MAX);
}

/**
 * Records `root` as this connection's most recent project directory: most recent first,
 * deduplicated, at most {@link PROJECT_ROOTS_MAX}, written atomically 0600. A malformed root is
 * ignored; a root already first is not rewritten.
 */
export function recordProjectRoot(connectionStateDir: string, root: string): void {
  if (!isRoot(root)) return;
  const roots = readProjectRoots(connectionStateDir);
  if (roots[0] === root) return;
  const next = [root, ...roots.filter((r) => r !== root)].slice(0, PROJECT_ROOTS_MAX);
  writePrivate(
    projectRootsPath(connectionStateDir),
    `${JSON.stringify({ version: PROJECT_ROOTS_VERSION, roots: next })}\n`,
  );
}

/** A root's real path, or its resolved spelling when it cannot be resolved (gone, unreadable). */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * This connection's roots (its own spelling, most recent first) that another logged-in connection
 * of the machine also lists in its projects.json, compared by real path. Never the other
 * connection's own roots, id or host.
 */
export function sharedProjectRoots(machineDir: string, selfDeviceId: string): string[] {
  const dir = connectionsDir(machineDir);
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch {
    return [];
  }
  const others = new Set<string>();
  for (const id of ids) {
    if (id === selfDeviceId || !DEVICE_ID_PATTERN.test(id)) continue;
    const other = join(dir, id);
    // a logged-out connection directory is no connection
    if (!existsSync(credentialPath(other))) continue;
    for (const r of readProjectRoots(other)) others.add(real(r));
  }
  if (others.size === 0 || !DEVICE_ID_PATTERN.test(selfDeviceId)) return [];
  return readProjectRoots(join(dir, selfDeviceId)).filter((r) => others.has(real(r)));
}
