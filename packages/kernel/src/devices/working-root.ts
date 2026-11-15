import { validateSandboxPathShape } from "@capybara-hq/plugin-sdk";
import type { SandboxMode } from "../sandbox/modes.js";

/**
 * What decides a conversation's working root (project root spec §4.3): the latest `project_root`
 * event of its root conversation (sub-agents inherit their root's binding). Null: the conversation
 * is free, or no run of it has recorded a snapshot yet (a bound conversation before its first run
 * start, an older log).
 */
export interface WorkingProject {
  /** The project's root on the device, as the event recorded it. */
  root: string;
  /** The event says the run cannot use the project (`unavailable` set). */
  unavailable: boolean;
}

/**
 * A root that would make the command review's "inside the workspace" cover the owner's whole home
 * (or every home): `/`, `/home`, `/Users`, a home directory itself (`/home/<u>`, `/Users/<u>`,
 * `/root`). The review's checks of shell rc files, SSH keys and other secrets are skipped for any
 * path inside its workspace, so such a project is never the working root: the conversation works in
 * the device's workspace and writes into the project ask, as before (fail closed).
 */
function coversHome(root: string): boolean {
  const parts = root.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  if (parts[0] === "home" || parts[0] === "Users") return parts.length <= 2;
  return parts[0] === "root" && parts.length === 1;
}

const isInside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

/**
 * The working root of a conversation (project root spec §4.3): the directory `Bash` runs in, where
 * `Glob` and `Grep` search by default, what a relative file-tool path resolves against, and the
 * command review's `workspace` fact. It is the project's root when the latest snapshot is usable,
 * else the device's `workspace` (free mode). It never widens anything: a root that is not a clean
 * absolute path, one the run cannot use, one outside the workspace in sandbox mode (where the
 * device reads nothing else), and one covering a home directory ({@link coversHome}) all fall back
 * to the device's workspace.
 */
export function workingRootOf(
  project: WorkingProject | null | undefined,
  device: { mode: SandboxMode; workspace: string },
): string {
  if (project == null || project.unavailable) return device.workspace;
  const root =
    project.root.length > 1 && project.root.endsWith("/")
      ? project.root.slice(0, -1)
      : project.root;
  if (validateSandboxPathShape(root).length > 0) return device.workspace;
  if (device.mode !== "auto" && !isInside(root, device.workspace)) return device.workspace;
  if (coversHome(root)) return device.workspace;
  return root;
}
