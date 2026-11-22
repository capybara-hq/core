import { posix } from "node:path";
import { validateSandboxPathShape } from "@capybara-hq/plugin-sdk";

/**
 * What decides a conversation's working root (project root spec §4.3): the latest `project_root`
 * event of its root conversation (sub-agents inherit their root's binding), or the bound root
 * itself while no run has recorded one yet. Null: the conversation is free.
 */
export interface WorkingProject {
  /** The project's root on the device, as the event recorded it. */
  root: string;
  /** The event says the run cannot use the project (`unavailable` set). */
  unavailable: boolean;
}

/** The fixed parents of home directories, lower-cased (compared case-insensitively). */
const HOME_PARENTS: ReadonlySet<string> = new Set(["/home", "/users"]);

/**
 * A root above the owner's home: `/`, every ancestor of the reported `home` (`/var/lib` for
 * `/var/lib/u`), and `/home` / `/Users` whatever the home and in any case (a macOS volume is
 * case-insensitive: `/users` is `/Users`). Too broad to be the review's workspace
 * (other users' files would be ordinary writes), so it is never the working root. The owner's home
 * itself may be: the review judges its home-level sensitive paths (shell rc files, SSH,
 * credentials) inside the workspace too.
 */
export function aboveHome(root: string, home: string | null | undefined): boolean {
  if (root === "/" || HOME_PARENTS.has(root.toLowerCase())) return true;
  return home != null && home !== root && isInside(home, root);
}

const isInside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

/**
 * The working root of a conversation (project root spec §4.3): the directory `Bash` runs in, where
 * `Glob` and `Grep` search by default, what a relative file-tool path resolves against, and the
 * command review's `workspace` fact. It is the project's root when the latest snapshot is usable,
 * else the device's `workspace` (free mode). It never widens anything: a root that is not a clean
 * absolute path, one the run cannot use and one above the owner's home ({@link aboveHome}) all
 * fall back to the device's workspace. Where a project may lie is its device provider's rule
 * (device-provider spec §6.1), checked when the project was added.
 */
export function workingRootOf(
  project: WorkingProject | null | undefined,
  device: { workspace: string; home?: string | null },
): string {
  if (project == null || project.unavailable) return device.workspace;
  const root =
    project.root.length > 1 && project.root.endsWith("/")
      ? project.root.slice(0, -1)
      : project.root;
  if (validateSandboxPathShape(root).length > 0) return device.workspace;
  if (aboveHome(root, device.home)) return device.workspace;
  return root;
}

/**
 * A root in the one form two roots are compared in (B-18): POSIX-normalized (`.` and doubled `/`
 * segments dropped) and without a trailing slash, `/` itself kept.
 */
export function canonicalRoot(root: string): string {
  const n = posix.normalize(root);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * A file-tool path as the command review judged it, for the person approving it: a relative path
 * joined to the working root and normalized; an absolute or `~` path as given.
 */
export function pathAgainstWorkingRoot(path: string, workingRoot: string): string {
  if (path.startsWith("/") || path.startsWith("~") || path === "") return path;
  return posix.normalize(posix.join(workingRoot, path));
}
