import { isAbsolute, join, resolve } from "node:path";
import { type SandboxRoots, SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import type {
  DeviceProjectReach,
  DeviceProjectRefusal,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { withCanonicalForms, within } from "./operation-types.js";

/**
 * The local read model of a sandboxed operation: what it may read (its project reach) and what it
 * never reads (secret and state paths, every other connection's working directory). Pure apart
 * from resolving links on the file system.
 */
export type ProjectReach = DeviceProjectReach;

/** How wide each reach is: workspace < paths < machine. */
export const PROJECT_REACH_RANK: Readonly<Record<ProjectReach, number>> = Object.freeze({
  workspace: 0,
  paths: 1,
  machine: 2,
});

/** Whether moving from `cur` to `next` widens what a sandboxed operation may read. */
export function reachWidens(cur: ProjectReach, next: ProjectReach): boolean {
  return PROJECT_REACH_RANK[next] > PROJECT_REACH_RANK[cur];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A device id used as one path component: never empty, `.`, `..` or containing a separator. */
function checkedDeviceId(deviceId: string): string {
  if (!deviceId || deviceId === "." || deviceId === ".." || /[/\\\0]/.test(deviceId))
    throw new SandboxScopeDeniedError(
      `Invalid device id ${JSON.stringify(deviceId)} in the connection list; remove that connection directory`,
    );
  return deviceId;
}

/** The name of a connection's private temporary parent inside the macOS user temp dir. */
export function privateTempParentName(deviceId: string): string {
  return `capybara-op-${checkedDeviceId(deviceId)}`;
}

/**
 * Every other connection's working directory (and, with `macTempBase`, its private temporary
 * parent), resolved. A connection this program cannot read fails closed: without its working
 * directory the sandbox could not deny it, so no sandboxed operation starts until it is fixed or
 * removed. The program state root (every connection's state) is denied separately.
 */
export function otherConnectionDenies(input: {
  ownDeviceId: string;
  connections: readonly { deviceId: string; workDir: string }[];
  unreadable: readonly { deviceId: string; reason: string }[];
  /** macOS user temp dir; adds join(base, privateTempParentName(id)) per other connection. */
  macTempBase?: string;
}): string[] {
  for (const u of input.unreadable) {
    if (u.deviceId === input.ownDeviceId) continue;
    throw new SandboxScopeDeniedError(
      `Cannot read connections/${u.deviceId} (${u.reason}), so its working directory cannot be ` +
        `kept out of the sandbox; fix that connection or remove it with ` +
        `capybara-device logout -c ${u.deviceId}`,
    );
  }
  const out = new Set<string>();
  for (const c of input.connections) {
    if (c.deviceId === input.ownDeviceId) continue;
    const id = checkedDeviceId(c.deviceId);
    if (!isAbsolute(c.workDir))
      throw new SandboxScopeDeniedError(
        `connections/${id} has a relative working directory; fix that connection or remove it ` +
          `with capybara-device logout -c ${id}`,
      );
    out.add(resolve(c.workDir));
    if (input.macTempBase !== undefined)
      out.add(join(resolve(input.macTempBase), privateTempParentName(id)));
  }
  return [...out];
}

/** Resolved, deduplicated, without entries inside another entry, sorted by code point. */
function outermost(paths: readonly string[]): string[] {
  const all = [...new Set(paths.map((p) => resolve(p)))];
  return all.filter((p) => !all.some((o) => o !== p && within(p, o))).sort(compare);
}

/**
 * What one sandboxed operation may read. machine: ["/"]; paths: projectPaths ∪ roots ∪ writeRoots;
 * workspace: roots ∪ writeRoots. Normalized, deduplicated, without entries inside another entry,
 * sorted by code point. The deny list still applies inside these roots.
 */
export function readRootsFor(input: {
  reach: ProjectReach;
  projectPaths: readonly string[];
  roots: Readonly<SandboxRoots>;
  writeRoots: readonly string[];
}): string[] {
  if (input.reach === "machine") return ["/"];
  const device = [input.roots.workspace, input.roots.skills, input.roots.tmp];
  return outermost([
    ...(input.reach === "paths" ? input.projectPaths : []),
    ...device,
    ...input.writeRoots,
  ]);
}

/** The real location of a path (nearest existing ancestor resolved, missing names appended). */
function canonical(path: string): string {
  const forms = withCanonicalForms([path]);
  return forms[forms.length - 1] ?? path;
}

/**
 * null when the path is allowed; else the refusal code. A deny matches when ANY form of the path
 * (given or canonical) is inside or equal to ANY form of a denied directory, so a link never
 * reaches a denied location; an allow needs the canonical form inside a root (in either of the
 * root's forms), so a link inside a listed path never leads out of it. Other connections are
 * checked first, then secret and state paths, then the reach. A path that only contains a denied
 * directory is not refused here: the sandbox denies inside it. A relative path is outside reach.
 */
export function projectPathRefusal(
  path: string,
  input: {
    reach: ProjectReach;
    projectPaths: readonly string[];
    roots: Readonly<SandboxRoots>;
    secretAndStateDenies: readonly string[];
    otherConnectionDenies: readonly string[];
  },
): DeviceProjectRefusal | null {
  if (!isAbsolute(path)) return "outside-reach";
  const given = resolve(path);
  const forms = withCanonicalForms([given]);
  const hits = (denies: readonly string[]) => {
    const all = withCanonicalForms(denies.map((d) => resolve(d)));
    return forms.some((f) => all.some((d) => within(f, d)));
  };
  if (hits(input.otherConnectionDenies)) return "other-connection";
  if (hits(input.secretAndStateDenies)) return "denied";
  if (input.reach === "machine") return null;
  const allowed = withCanonicalForms(
    [
      ...(input.reach === "paths" ? input.projectPaths : []),
      input.roots.workspace,
      input.roots.skills,
      input.roots.tmp,
    ].map((r) => resolve(r)),
  );
  const real = canonical(given);
  return allowed.some((r) => within(real, r)) ? null : "outside-reach";
}
