import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  type DeviceListResult,
  type DeviceProjectCandidate,
  type DeviceScanResult,
  isDeviceProjectName,
  MAX_DEVICE_SCAN_DEPTH,
  MAX_DEVICE_SCAN_DIRS,
  MAX_DEVICE_SCAN_RESULTS,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import { isMissing } from "./shared.js";
import { DeviceOpError } from "./types.js";

/**
 * `list` and `scan` with this process's rights (auto mode, the owner's machine). Sandbox mode reads
 * through the sandboxed helper (`fs-helper.ts`) and a container device in its container
 * (`docker.ts`'s `LIST_SCRIPT`): each follows the same rules, so every reader answers the same.
 */

/** Directory names a scan never enters at any depth: dependency trees, not projects. */
export const SCAN_SKIP_ANYWHERE: readonly string[] = ["node_modules"];
/**
 * Directory names a scan does not enter right under its base: the owner's macOS `Library` (app
 * data, huge, partly privacy-protected) is not where projects live.
 */
export const SCAN_SKIP_AT_BASE: readonly string[] = ["Library"];

/** `a` before `b` in UTF-16 code-unit order (locale-independent). */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ` (CODE)` of a file system error, never its message (which may name where a link resolves). */
function errnoSuffix(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

/** The real path of `path`, null when it does not exist; throws when it cannot be resolved. */
async function realOf(path: string): Promise<string | null> {
  try {
    return await realpath(resolve(path));
  } catch (e) {
    if (isMissing(e)) return null;
    throw new DeviceOpError("error", `${path} cannot be read${errnoSuffix(e)}`);
  }
}

/** The entries of the real directory `real` (`path` names it in messages); throws when unreadable. */
async function entriesOf(real: string, path: string): Promise<Dirent[]> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(real);
  } catch (e) {
    throw new DeviceOpError("error", `${path} cannot be read${errnoSuffix(e)}`);
  }
  if (!st.isDirectory()) throw new DeviceOpError("error", `${path} is not a directory`);
  try {
    return await readdir(real, { withFileTypes: true });
  } catch (e) {
    throw new DeviceOpError("error", `${path} cannot be read${errnoSuffix(e)}`);
  }
}

/**
 * Whether the entry of the real directory `dir` is a directory, following a symbolic link (a
 * dangling one is not): the link is resolved, then its real target is checked.
 */
async function isDirEntry(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(await realpath(join(dir, entry.name)))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One directory's entries (`SandboxProvider.list`): sorted by code unit, at most `limit`,
 * `truncated` when there are more; `isDir` follows symbolic links. Null when the path does not
 * exist; a file or an unreadable directory throws an error.
 */
export async function listDirectory(path: string, limit: number): Promise<DeviceListResult> {
  const real = await realOf(path);
  if (real === null) return null;
  const all = (await entriesOf(real, path)).sort((a, b) => byCodeUnit(a.name, b.name));
  const entries = await Promise.all(
    all.slice(0, limit).map(async (e) => ({ name: e.name, isDir: await isDirEntry(real, e) })),
  );
  return { entries, truncated: all.length > limit };
}

/** Whether a scan enters a directory named `name` found at `depth` (0: right under the base). */
export function enterable(name: string, depth: number): boolean {
  if (name.startsWith(".")) return false;
  if (SCAN_SKIP_ANYWHERE.includes(name)) return false;
  return !(depth === 0 && SCAN_SKIP_AT_BASE.includes(name));
}

/**
 * Directories that look like projects under `base` (`SandboxProvider.scan`'s traversal): `base`
 * and the directories at most `MAX_DEVICE_SCAN_DEPTH` levels below it holding a `.git` entry or an
 * `AGENTS.md` file. Symbolic links are never followed below `base`; hidden directories and
 * {@link SCAN_SKIP_ANYWHERE} / {@link SCAN_SKIP_AT_BASE} are not entered. Directories are visited
 * breadth-first, each level in code-unit order of path, at most `MAX_DEVICE_SCAN_DIRS` visits with
 * `base` the first; a subdirectory that cannot be read is skipped (it counts as visited). Reads are
 * async and `signal` is checked before each visit. A missing base answers `[]`; a file or an
 * unreadable one throws.
 */
export async function scanDirectory(
  base: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DeviceScanResult> {
  opts.signal?.throwIfAborted();
  const report = resolve(base);
  const real = await realOf(base);
  if (real === null) return [];
  const first = await entriesOf(real, base);
  const found: string[] = [];
  let visits = 1;
  type Node = { dir: string; report: string };
  /** Records a hit and returns the directories to visit below `node`, found at `depth`. */
  const below = (node: Node, entries: Dirent[], depth: number): Node[] => {
    if (entries.some((e) => e.name === ".git" || (e.name === "AGENTS.md" && !e.isDirectory()))) {
      found.push(node.report);
    }
    if (depth >= MAX_DEVICE_SCAN_DEPTH) return [];
    return entries
      .filter((e) => e.isDirectory() && enterable(e.name, depth))
      .map((e) => ({ dir: join(node.dir, e.name), report: join(node.report, e.name) }));
  };
  let level = below({ dir: real, report }, first, 0);
  // breadth-first, each level in code-unit order of path, until the visit budget is spent
  for (let depth = 1; level.length > 0; depth++) {
    level.sort((a, b) => byCodeUnit(a.report, b.report));
    const next: Node[] = [];
    for (const node of level) {
      if (visits >= MAX_DEVICE_SCAN_DIRS) return finishScan(found);
      opts.signal?.throwIfAborted();
      visits += 1;
      let entries: Dirent[];
      try {
        entries = await readdir(node.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      next.push(...below(node, entries, depth));
    }
    level = next;
  }
  return finishScan(found);
}

/**
 * The answer of a scan: candidates whose basename satisfies the project name rule and whose path
 * the protocol accepts (others are skipped, never renamed), sorted by path in code-unit order, the
 * first {@link MAX_DEVICE_SCAN_RESULTS}.
 */
export function finishScan(found: readonly string[]): DeviceProjectCandidate[] {
  const out: DeviceProjectCandidate[] = [];
  const seen = new Set<string>();
  for (const path of found) {
    const name = basename(path);
    if (seen.has(path) || !isDeviceProjectName(name)) continue;
    if (validateSandboxPathShape(path).length > 0) continue;
    seen.add(path);
    out.push({ path, suggestedName: name });
  }
  return out.sort((a, b) => byCodeUnit(a.path, b.path)).slice(0, MAX_DEVICE_SCAN_RESULTS);
}
