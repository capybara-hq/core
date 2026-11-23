import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type SandboxRoots, SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import type {
  DeviceProjectReach,
  DeviceProjectRefusal,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { defaultWorkDir } from "../state.js";
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

const tempParentName = (checkedId: string) => `capybara-op-${checkedId}`;

/** The name of a connection's private temporary parent inside the macOS user temp dir. */
export function privateTempParentName(deviceId: string): string {
  return tempParentName(checkedDeviceId(deviceId));
}

/**
 * Why sandboxed work cannot start while another connection of this machine cannot be read: without
 * its working directory the sandbox could not deny it. Actionable: names the connection, the
 * reason and how to remove it.
 */
export function unreadableConnectionMessage(u: { deviceId: string; reason: string }): string {
  return (
    `Cannot read connections/${u.deviceId} (${u.reason}), so its working directory cannot be ` +
    `kept out of the sandbox; fix that connection or remove it with ` +
    `capybara-device logout -c ${u.deviceId}`
  );
}

/**
 * Every other connection's working directory (and, with `macTempBases`, its private temporary
 * parent), resolved; for each other connection directory without a credential (logged out), its
 * default working directory under `home` and its private temporary parents. Connections this
 * program cannot read are not here: the owner ceiling carries them and refuses every sandboxed
 * grant while one exists ({@link unreadableConnectionMessage}). The program state root (every
 * connection's state) is denied separately.
 */
export function otherConnectionDenies(input: {
  ownDeviceId: string;
  connections: readonly { deviceId: string; workDir: string }[];
  /** Ids of connection directories without a credential; needs {@link home}. */
  credentialless?: readonly string[];
  /** The home the default working directories of {@link credentialless} lie under. */
  home?: string;
  /**
   * The bases of the macOS private temporary parents (the user temp dir and the process temp
   * dir the worker falls back to); adds join(base, privateTempParentName(id)) per other connection
   * and base.
   */
  macTempBases?: readonly string[];
}): string[] {
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
    for (const base of input.macTempBases ?? []) out.add(join(resolve(base), tempParentName(id)));
  }
  const credentialless = (input.credentialless ?? []).filter((id) => id !== input.ownDeviceId);
  if (credentialless.length > 0 && (input.home === undefined || !isAbsolute(input.home)))
    throw new SandboxScopeDeniedError(
      "No absolute home to deny the working directories of logged-out connections under",
    );
  for (const raw of credentialless) {
    const id = checkedDeviceId(raw);
    out.add(resolve(defaultWorkDir(id, input.home as string)));
    for (const base of input.macTempBases ?? []) out.add(join(resolve(base), tempParentName(id)));
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

/** At most this many dangling links are followed for one path (a link loop ends here). */
const MAX_DANGLING_HOPS = 40;

/**
 * The forms a path takes when its dangling links (links whose target does not exist yet) are
 * followed by their link text: `realpath` cannot resolve them, so a link to a missing name inside
 * a denied directory would otherwise look like a path outside it. `dangling` says whether any
 * component of the path was such a link (or the hops ran out, as with a link loop).
 */
function danglingLinkForms(path: string): { forms: string[]; dangling: boolean } {
  const forms: string[] = [];
  let cur = path;
  for (let hop = 0; hop < MAX_DANGLING_HOPS; hop++) {
    const next = followFirstDanglingLink(cur);
    if (next === null) return { forms, dangling: forms.length > 0 };
    forms.push(next);
    cur = next;
  }
  return { forms, dangling: true };
}

/** `path` with its first dangling link replaced by the link's target; null when it has none. */
function followFirstDanglingLink(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  let prefix = "/";
  for (let i = 0; i < parts.length; i++) {
    prefix = join(prefix, parts[i] as string);
    let isLink: boolean;
    try {
      isLink = lstatSync(prefix).isSymbolicLink();
    } catch {
      return null; // a missing name: nothing below it exists, so no link either
    }
    if (!isLink) continue;
    try {
      realpathSync.native(prefix);
    } catch {
      const target = resolve(dirname(prefix), readlinkSync(prefix));
      return join(target, ...parts.slice(i + 1));
    }
  }
  return null;
}

/** The real location of a path (nearest existing ancestor resolved, missing names appended). */
function canonical(path: string): string {
  const forms = withCanonicalForms([path]);
  return forms[forms.length - 1] ?? path;
}

/** The macOS data volume, lower case: every firmlinked system location also answers below it. */
const DARWIN_DATA_VOLUME = "/system/volumes/data/";

/**
 * On macOS, `paths` plus, for each one spelled below the data volume (`/System/Volumes/Data/...`,
 * compared ignoring case as on the default APFS volume), its firmlink spelling `/...`. A firmlink
 * is not a symlink, so `realpath` keeps either spelling as given; used for the deny checks only,
 * where an extra form can only add a refusal. Elsewhere `paths` as given.
 */
export function withFirmlinkForms(paths: readonly string[]): string[] {
  if (process.platform !== "darwin") return [...paths];
  const out = new Set(paths);
  for (const p of paths)
    if (p.toLowerCase().startsWith(DARWIN_DATA_VOLUME))
      out.add(p.slice(DARWIN_DATA_VOLUME.length - 1));
  return withCanonicalForms([...out]);
}

/**
 * null when the path is allowed; else the refusal code. A deny matches when ANY form of the path
 * (given or canonical) is inside or equal to ANY form of a denied directory, so a link never
 * reaches a denied location; an allow needs the canonical form inside a root (in either of the
 * root's forms), so a link inside a listed path never leads out of it. Other connections are
 * checked first, then secret and state paths, then the reach. A path that only contains a denied
 * directory is not refused here: the sandbox denies inside it. A relative path is outside reach.
 * A dangling link is followed by its link text for the deny check, and is outside a narrower reach.
 * On macOS the deny check also matches the firmlink spelling of a path or deny below
 * `/System/Volumes/Data`; the reach check does not.
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
  const followed = danglingLinkForms(given);
  const forms = withFirmlinkForms(withCanonicalForms([given, ...followed.forms]));
  const hits = (denies: readonly string[]) => {
    const all = withFirmlinkForms(withCanonicalForms(denies.map((d) => resolve(d))));
    return forms.some((f) => all.some((d) => within(f, d)));
  };
  if (hits(input.otherConnectionDenies)) return "other-connection";
  if (hits(input.secretAndStateDenies)) return "denied";
  if (input.reach === "machine") return null;
  // the sandbox decides a dangling link when its target appears; nothing proves it stays in reach
  if (followed.dangling) return "outside-reach";
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
