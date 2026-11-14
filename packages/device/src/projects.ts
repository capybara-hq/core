import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { DeviceProject, SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { Policy, SandboxMode } from "./state.js";

/** The most candidates a `projectCandidates` answer carries. */
export const MAX_CANDIDATES = 50;

/** How far under the base candidates are looked for: its children and its grandchildren. */
export const MAX_CANDIDATE_DEPTH = 2;

/**
 * What a device's current mode lets it offer (spec §4.2). The rule is one rule for every device:
 * a device may offer what it can read in its mode, and nothing else.
 */
export interface ProjectScope {
  /** `sandbox`: only `base` may be offered; `auto`: any directory its owner can read. */
  mode: SandboxMode;
  /**
   * The directory relative paths are taken from, and in sandbox mode the only one offered: the
   * device's workspace, or the owner's home in auto mode.
   */
  base: string;
}

/**
 * The scope of a device in `mode` (the effective one, the owner's choice cut to the kernel's
 * ceiling): its workspace in sandbox mode, the owner's home in auto mode, which relative paths
 * resolve against. A container device offers only its workspace in either mode: what lies outside
 * it is not mounted, so the owner cannot read it there (spec §4.2).
 */
export function projectScope(
  mode: SandboxMode,
  roots: Pick<SandboxRoots, "workspace">,
  container: boolean,
  home: string = homedir(),
): ProjectScope {
  if (container || mode === "sandbox") return { mode: "sandbox", base: roots.workspace };
  return { mode: "auto", base: home };
}

/** The absolute path `raw` names, a relative one taken from the scope's base. */
export function projectPath(scope: ProjectScope, raw: string): string {
  return resolve(scope.base, raw);
}

/** Whether `path` is `root` or lies under it (lexically, like the device's other path checks). */
function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The projects the policy serves, as a copy: the policy file is the source of truth. */
export function listProjects(policy: Pick<Policy, "projects">): DeviceProject[] {
  return policy.projects.map(({ name, path }) => ({ name, path }));
}

/**
 * The project `input` asks for, or why the device may not serve it. Pure: the directory is not
 * touched here (the caller checks it exists and is readable in its mode), and the policy is not
 * changed. A path outside what the mode allows (the workspace in sandbox mode) is refused; the
 * name defaults to the directory's basename, and a name already served is refused.
 */
export function addProject(
  policy: Pick<Policy, "projects">,
  input: { path: string; name?: string },
  scope: ProjectScope,
): { project: DeviceProject } | { refused: string } {
  const path = projectPath(scope, input.path);
  if (scope.mode === "sandbox" && !isUnder(path, scope.base)) {
    return {
      refused: `${path} is outside the device's workspace; this device can offer only what is inside it`,
    };
  }
  const name = input.name ?? basename(path);
  if (name === "" || name.includes("/")) {
    return { refused: `${path} has no usable directory name; give the project a name` };
  }
  if (policy.projects.some((p) => p.name === name)) {
    return {
      refused: `a project named "${name}" is already served; remove it or pick another name`,
    };
  }
  return { project: { name, path } };
}

/**
 * Whether the policy serves a project named `name`. Pure: the policy is not changed, the caller
 * writes the list without it ({@link Policy}'s `projects` is the only source of truth).
 */
export function removeProject(policy: Pick<Policy, "projects">, name: string): boolean {
  return policy.projects.some((p) => p.name === name);
}

/** The directory's entries, sorted by name; empty when it cannot be read (never throws). */
function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return [];
  }
}

/**
 * Whether `dir` looks like a project: it holds a `.git` entry (a directory, or a worktree's file)
 * or an `AGENTS.md` file. Only names are read, never a file's contents.
 */
function looksLikeProject(dir: string): boolean {
  return entries(dir).some(
    (e) => e.name === ".git" || (e.name === "AGENTS.md" && !e.isDirectory()),
  );
}

/**
 * Directories under `root` that look like projects, at most {@link MAX_CANDIDATE_DEPTH} levels
 * down and at most `limit` entries: suggestions for the owner, never a listing of the disk. Hidden
 * directories and symbolic links are skipped (noise, cycles, and in sandbox mode nothing outside
 * the workspace is readable anyway); the root itself is not a candidate.
 */
export function candidates(root: string, limit: number): DeviceProject[] {
  const out: DeviceProject[] = [];
  if (limit <= 0) return out;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && out.length < limit) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    for (const entry of entries(dir)) {
      if (out.length >= limit) break;
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (looksLikeProject(child)) out.push({ name: entry.name, path: child });
      if (depth + 1 < MAX_CANDIDATE_DEPTH) queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return out;
}
