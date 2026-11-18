import { posix } from "node:path";
import { validateSandboxPathShape } from "@capybara-hq/plugin-sdk";
import { canonicalRoot } from "../devices/working-root.js";
import type { ExecutionClaim } from "../runtime/run-execution.js";

/**
 * A kernel read of a device on behalf of a run start (permission activation L2, Hook 1): the
 * run's current execution claim and what is read. Only `project_root` exists: the bound project's
 * `AGENTS.md` and `.agents/skills/**` read before the run's first model call. Supplied only by
 * `ProjectKnowledgeService`, never by a tool, a Platform operation or an HTTP route.
 */
export interface KernelReadInvocation {
  claim: ExecutionClaim;
  purpose: "project_root";
  /** The conversation's bound project root (`conversations.project_path`). */
  root: string;
}

/** The directory of a project's skills, relative to its root (project root spec §4.7). */
export const PROJECT_SKILLS_DIR = ".agents/skills";

/** The methods a kernel read may use: never a write, an exec or a scan. */
export type KernelReadMethod = "stat" | "readFile" | "list";

export const isKernelReadMethod = (method: string): method is KernelReadMethod =>
  method === "stat" || method === "readFile" || method === "list";

/**
 * The one path a kernel read of `root` may reach with `method` that covers `path`, the operation's
 * only read root; null when the read is outside it. A `stat` of the root itself (whether the
 * project is still there); `stat` and `readFile` of `<root>/AGENTS.md`; any of the three inside
 * `<root>/.agents/skills`. Never anything else under the root, and never a path that is not
 * clean and absolute.
 */
export function kernelReadRoot(
  root: string,
  method: KernelReadMethod,
  path: string,
): string | null {
  const base = canonicalRoot(root);
  if (validateSandboxPathShape(base).length > 0) return null;
  if (validateSandboxPathShape(path).length > 0 || posix.normalize(path) !== path) return null;
  if (path === base) return method === "stat" ? base : null;
  const agents = `${base === "/" ? "" : base}/AGENTS.md`;
  if (path === agents) return method === "list" ? null : agents;
  const skills = `${base === "/" ? "" : base}/${PROJECT_SKILLS_DIR}`;
  if (path === skills || path.startsWith(`${skills}/`)) return skills;
  return null;
}

/**
 * A kernel read that was not admitted (its run is no longer the claim's queued run start, the
 * authority refused it, its scope changed before dispatch): nothing was sent to the device. The
 * knowledge read treats it as a device that could not be asked, never as an unreadable project.
 */
export class KernelReadNotAdmitted extends Error {
  constructor(cause: unknown) {
    super("The kernel read was not admitted; nothing was sent to the device", { cause });
    this.name = "KernelReadNotAdmitted";
  }
}

/**
 * How a kernel read is sent, from the device's recorded runtime support and whether its runtime is
 * isolated (its file system holds no host home: a cloud device, or a local machine recorded in its
 * Docker mode): `restricted` whenever the runtime enforces the restricted profiles (the read-only
 * scope, whatever the conversation selected); `full` only for an isolated Full-only runtime (the
 * conversation's admitted Full access, still with the one covering path and the read methods);
 * `refused` otherwise (a host machine without restricted enforcement: fail closed).
 */
export type KernelReadRoute = "restricted" | "full" | "refused";

export function kernelReadRoute(support: {
  restricted: boolean;
  fullAccess: boolean;
  isolated: boolean;
}): KernelReadRoute {
  if (support.restricted) return "restricted";
  if (support.fullAccess && support.isolated) return "full";
  return "refused";
}

/**
 * The device's runtime cannot enforce a read-only kernel read of the project (a host machine
 * without restricted enforcement): nothing is sent, and the project is recorded unreadable.
 */
export class KernelReadUnsupported extends Error {
  constructor() {
    super("This device's runtime cannot enforce a read-only kernel read on its host");
    this.name = "KernelReadUnsupported";
  }
}
