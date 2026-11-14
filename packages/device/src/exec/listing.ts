import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  type DeviceListResult,
  type DeviceProjectCandidate,
  type DeviceScanResult,
  isDeviceProjectName,
  MAX_DEVICE_SCAN_DEPTH,
  MAX_DEVICE_SCAN_RESULTS,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import { isMissing, isUnder, policyError } from "./shared.js";
import { DeviceOpError } from "./types.js";

/**
 * The most directories one `scan` reads (its base included). A home with thousands of directories
 * is not walked to the end: the answer is what was found within this budget, so a scan never runs
 * for long, even through the owner's whole home.
 */
export const MAX_SCAN_DIRS = 500;

/** Directory names a scan never enters at any depth: dependency trees, not projects. */
export const SCAN_SKIP_ANYWHERE: readonly string[] = ["node_modules"];
/**
 * Directory names a scan does not enter right under its base: the owner's macOS `Library` (app
 * data, huge, partly privacy-protected) is not where projects live.
 */
export const SCAN_SKIP_AT_BASE: readonly string[] = ["Library"];

/**
 * Where a read may go. Without `root`, any path the owner can read (auto mode). With it, only
 * `root.path` and what lies under it (the workspace in sandbox mode, a container's mounted
 * workspace): a path is checked lexically against `root.path` before anything is read, then by
 * its real path against `root.path`'s real path. `root.describe` names it in refusals.
 */
export interface ReadArea {
  root?: { path: string; describe: string };
}

/** `a` before `b` in UTF-16 code-unit order (locale-independent). */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ` (CODE)` of a file system error, never its message (which may name where a link resolves). */
export function errnoSuffix(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

function outside(path: string, describe: string): DeviceOpError {
  return policyError(`${path} is outside ${describe}; in this mode the device reads only that`);
}

/**
 * The real path of `path` (null when it does not exist), refused when it leaves the area: a path
 * lexically outside the area is refused before anything is read, so a missing path outside it is
 * a refusal, never null.
 */
async function resolveIn(
  path: string,
  area: ReadArea,
  label: string,
): Promise<{ real: string; realRoot: string | undefined } | null> {
  const p = resolve(path);
  const root = area.root;
  if (root !== undefined && !isUnder(p, root.path)) throw outside(label, root.describe);
  let real: string;
  try {
    real = await realpath(p);
  } catch (e) {
    if (isMissing(e)) return null;
    throw new DeviceOpError("error", `${label} cannot be read${errnoSuffix(e)}`);
  }
  if (root === undefined) return { real, realRoot: undefined };
  const realRoot = await realpath(root.path).catch(() => root.path);
  if (!isUnder(real, realRoot)) throw outside(label, root.describe);
  return { real, realRoot };
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
 * Whether the entry `name` of the real directory `dir` is a directory, following a symbolic link
 * (a dangling one is not). Inside an area, a link whose target leaves it counts as not a directory:
 * the answer never says what lies outside the area.
 */
async function isDirEntry(
  dir: string,
  entry: Dirent,
  realRoot: string | undefined,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  const full = join(dir, entry.name);
  try {
    if (realRoot !== undefined && !isUnder(await realpath(full), realRoot)) return false;
    return (await stat(full)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One directory's entries (`SandboxProvider.list`): sorted by code unit, at most `limit`,
 * `truncated` when there are more; `isDir` follows symbolic links. Null when the path does not
 * exist inside the area; a path outside it throws a `policy` refusal, a file or an unreadable
 * directory an error. `label` is the path messages name (the path the request named, when this
 * process reads it at another one).
 */
export async function listDirectory(
  path: string,
  limit: number,
  area: ReadArea,
  label: string = path,
): Promise<DeviceListResult> {
  const at = await resolveIn(path, area, label);
  if (at === null) return null;
  const all = (await entriesOf(at.real, label)).sort((a, b) => byCodeUnit(a.name, b.name));
  const kept = all.slice(0, limit);
  const entries = await Promise.all(
    kept.map(async (e) => ({ name: e.name, isDir: await isDirEntry(at.real, e, at.realRoot) })),
  );
  return { entries, truncated: all.length > limit };
}

/**
 * Directories that look like projects under `base` (`SandboxProvider.scan`'s traversal): `base`
 * and the directories at most {@link MAX_DEVICE_SCAN_DEPTH} levels below it holding a `.git` entry
 * or an `AGENTS.md` file. Symbolic links are never followed below `base`, hidden directories and
 * {@link SCAN_SKIP_ANYWHERE} / {@link SCAN_SKIP_AT_BASE} are not entered, and at most
 * {@link MAX_SCAN_DIRS} directories are read; a subdirectory that cannot be read is skipped.
 * Reads are async, and `signal` is checked between directories. `reportAs` is the path the
 * caller knows `base` by when this process reads it at another path (a container's workspace,
 * read through the host directory mounted there): each candidate's path is mapped under it.
 * A missing base answers `[]`; a base outside the area, a file or an unreadable one throws (its
 * messages name `reportAs` when given).
 */
export async function scanDirectory(
  base: string,
  area: ReadArea,
  opts: { reportAs?: string; signal?: AbortSignal } = {},
): Promise<DeviceScanResult> {
  const report = opts.reportAs ?? resolve(base);
  const at = await resolveIn(base, area, report);
  if (at === null) return [];
  const real = at.real;
  const first = await entriesOf(real, report);
  const found: string[] = [];
  let budget = MAX_SCAN_DIRS - 1;
  const queue: { dir: string; report: string; depth: number; entries?: Dirent[] }[] = [
    { dir: real, report, depth: 0, entries: first },
  ];
  while (queue.length > 0) {
    opts.signal?.throwIfAborted();
    const item = queue.shift() as (typeof queue)[number];
    let entries = item.entries;
    if (entries === undefined) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        entries = await readdir(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }
    }
    if (entries.some((e) => e.name === ".git" || (e.name === "AGENTS.md" && !e.isDirectory()))) {
      found.push(item.report);
    }
    if (item.depth >= MAX_DEVICE_SCAN_DEPTH) continue;
    for (const e of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      if (!e.isDirectory() || !enterable(e.name, item.depth)) continue;
      queue.push({
        dir: join(item.dir, e.name),
        report: join(item.report, e.name),
        depth: item.depth + 1,
      });
    }
  }
  return finishScan(found);
}

/** Whether a scan enters a directory named `name` found at `depth` (0: right under the base). */
export function enterable(name: string, depth: number): boolean {
  if (name.startsWith(".")) return false;
  if (SCAN_SKIP_ANYWHERE.includes(name)) return false;
  return !(depth === 0 && SCAN_SKIP_AT_BASE.includes(name));
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

/** `path` (lexically under `from`) moved under `to`. */
export function rebase(path: string, from: string, to: string): string {
  const rel = relative(from, resolve(path));
  return rel === "" ? to : join(to, rel);
}
