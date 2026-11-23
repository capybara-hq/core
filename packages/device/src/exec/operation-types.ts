import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEVICE_DEFAULT_STATE_PATH,
  type SandboxLimits,
  type SandboxOperationScope,
  type SandboxRoots,
  SandboxScopeDeniedError,
  sandboxRuntimeDirectoryOf,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type {
  DeviceExecGrants,
  DeviceNetworkMode,
  DeviceProjectRefusal,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { machineDirOfConnection, scanConnections } from "../connections.js";
import { covers, deniedSecretPaths, effectiveEgress } from "../policy.js";
import { policyPath, readPolicyFile } from "../state.js";
import { fsNameBytes, fsNameString, homeFsName } from "./fs-names.js";
import {
  otherConnectionDenies,
  type ProjectReach,
  projectPathRefusal,
  readRootsFor,
  unreadableConnectionMessage,
} from "./read-model.js";
import { macUserTempDir, osRoots } from "./shared.js";

/**
 * The owner ceiling as this program enforces it: the fields of the protocol's
 * `DeviceOwnerCeiling` (the device sandbox for every profile) plus the local facts the
 * intersection needs (roots, project reach, denied read roots, preparation roots).
 */
export interface DeviceOwnerCeiling {
  readonly revision: string;
  /** Whether a call may be granted escalation outside the sandbox (device + environment). */
  readonly outsideSandbox: boolean;
  /** The sandbox network: the open public internet or the {@link allowedDomains} allowlist. */
  readonly network: DeviceNetworkMode;
  readonly allowedDomains: readonly string[];
  readonly roots: Readonly<SandboxRoots>;
  /** What a sandboxed operation of this connection reads: machine, paths or workspace. */
  readonly projectReach: ProjectReach;
  /** Canonical (real path) forms of the policy's project paths that exist as directories. */
  readonly projectPaths: readonly string[];
  /**
   * Secret paths, this connection's state, the program state root and the default state path
   * (`~/.config/capybara-device`), canonical forms included.
   */
  readonly secretAndStateDenies: readonly string[];
  /**
   * Every other connection's working directory (and on macOS its private temporary parent),
   * canonical forms included.
   */
  readonly otherConnectionDenies: readonly string[];
  /**
   * Other connections of this machine this program cannot read (their working directory is
   * unknown, so it cannot be denied): while any is here every sandboxed grant is refused
   * ({@link assertConnectionsReadable}); an escalated call and the owner report proceed.
   */
  readonly unreadableConnections: readonly Readonly<{ deviceId: string; reason: string }>[];
  /** {@link secretAndStateDenies} ∪ {@link otherConnectionDenies}: what every sandboxed grant denies. */
  readonly restrictedDeniedReadRoots: readonly string[];
  readonly preparation: Readonly<{ skillsRoot: string; attachmentsBase: string }>;
}
export interface LocalExecAuthority {
  readonly operationId: string;
  readonly orgNetwork: SandboxLimits["network"];
  readonly grants?: DeviceExecGrants;
}
export interface LocalOperationGrant {
  /** Only an escalated call (device + environment): it runs outside the sandbox. */
  readonly full: boolean;
  /**
   * A sandboxed command may reach the open public internet (the address classes the design closes
   * stay closed). Absent or false: exactly {@link hosts}, so a grant that does not say otherwise
   * fails closed. Never set on a {@link full} grant, which has the escalated call's own network.
   */
  readonly openNetwork?: boolean;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly hosts: readonly string[];
  readonly deniedReadRoots: readonly string[];
  readonly revision: string;
}
export function within(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** What {@link readStrictOwnerCeilingSync} reads. */
export interface OwnerCeilingInput {
  /** This connection's state directory (its policy.json). */
  stateDir: string;
  deviceId: string;
  /** This connection's device directory. */
  dir: string;
  home?: string;
  /**
   * The program state root holding every connection's state (the CLI's `stateDir(env, home)`).
   * Required: a default from this process's environment could read another user's or the real
   * machine's state in tests and embedders.
   */
  stateRoot: string;
  /**
   * The connections of this machine, called on every read; default {@link scanConnections} of
   * {@link stateRoot}.
   */
  connections?: () => {
    readable: readonly { deviceId: string; workDir: string }[];
    unreadable: readonly { deviceId: string; reason: string }[];
    /** Ids of connection directories without a credential (logged out); default none. */
    credentialless?: readonly string[];
  };
  /**
   * The macOS temp dirs that may hold a connection's private temporary parent; default on macOS
   * the user temp dir and this process's temp dir (the worker's fallback), elsewhere none.
   */
  macTempBases?: readonly string[];
}
/** Strict additive reader: no absent-file defaults or last-good fallback. */
export async function readStrictOwnerCeiling(
  input: OwnerCeilingInput,
): Promise<DeviceOwnerCeiling> {
  return readStrictOwnerCeilingSync(input);
}
/** The macOS user temp dir the operation worker makes private temporary directories in. */
function defaultMacTempBases(): string[] {
  if (process.platform !== "darwin") return [];
  // the worker's base: the user temp dir, else this process's temp dir (which depends on each
  // process's TMPDIR): every form is denied
  const bases = new Set<string>();
  const user = macUserTempDir();
  if (user !== undefined) bases.add(user);
  try {
    bases.add(realpathSync(tmpdir()));
  } catch {
    bases.add(resolve(tmpdir()));
  }
  return [...bases];
}
/**
 * The real paths of the listed project paths that exist as directories, without duplicates. A
 * missing one grants nothing (a project root under it is outside the reach), and one whose real
 * path is `/` (a link to the root) is never a project path.
 */
function canonicalProjectPaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    try {
      const real = realpathSync.native(path);
      if (real !== "/" && statSync(real).isDirectory()) out.add(real);
    } catch {
      // missing or unreadable: not granted
    }
  }
  return [...out];
}
/**
 * {@link readStrictOwnerCeiling}, synchronously (the owner report issues it under the policy lock).
 * Only a policy file in the current format is authority: another version is refused. The
 * connections of this machine are read every time; one that cannot be read (or names a relative
 * working directory) is carried in `unreadableConnections`, which refuses every sandboxed grant.
 */
export function readStrictOwnerCeilingSync(input: OwnerCeilingInput): DeviceOwnerCeiling {
  // Correct by construction: the state root must be the machine directory holding this
  // connection's directory. Any other root would scan the wrong connections/ (an absent one reads
  // as no connections) and leave the other connections readable: refused instead.
  const stateRoot = resolve(input.stateRoot);
  let layoutRoot: string | undefined;
  try {
    layoutRoot = machineDirOfConnection(resolve(input.stateDir));
  } catch {
    layoutRoot = undefined;
  }
  if (layoutRoot !== stateRoot)
    throw new SandboxScopeDeniedError(
      `Owner state layout mismatch: ${resolve(input.stateDir)} is not a connection directory ` +
        `of ${stateRoot} (<machineDir>/connections/<deviceId>)`,
    );
  const file = policyPath(input.stateDir);
  const before = statSync(file);
  if (!before.isFile()) throw new SandboxScopeDeniedError("Owner policy must be a regular file");
  const read = readPolicyFile(input.stateDir);
  const policy = read.policy;
  const after = statSync(file);
  const version = (s: typeof before) => `${s.ino}:${s.size}:${s.mtimeMs}`;
  if (version(before) !== version(after))
    throw new SandboxScopeDeniedError(
      "Owner policy changed while reading; resolve fresh authority",
    );
  if (policy.allowedDomains.some((h) => validateAllowHost(h).length > 0))
    throw new SandboxScopeDeniedError("Owner policy contains invalid allowed domains");
  const roots = Object.freeze(osRoots(resolve(input.dir)));
  const connections = input.connections ? input.connections() : scanConnections(stateRoot);
  const others = connections.readable.filter((c) => c.deviceId !== input.deviceId);
  const unreadable = [
    ...connections.unreadable
      .filter((u) => u.deviceId !== input.deviceId)
      .map((u) => Object.freeze({ deviceId: u.deviceId, reason: u.reason })),
    ...others
      .filter((c) => !isAbsolute(c.workDir))
      .map((c) =>
        Object.freeze({ deviceId: c.deviceId, reason: "its working directory is not absolute" }),
      ),
  ].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  const macTempBases = input.macTempBases ?? defaultMacTempBases();
  const home = resolve(input.home ?? homeFsName(homedir()));
  const otherDirs = otherConnectionDenies({
    ownDeviceId: input.deviceId,
    connections: others.filter((c) => isAbsolute(c.workDir)),
    credentialless: connections.credentialless ?? [],
    home,
    macTempBases,
  });
  const secretAndStateDenies = withCanonicalForms([
    ...deniedSecretPaths(home),
    resolve(input.stateDir),
    stateRoot,
    // the default state path too, whatever XDG_CONFIG_HOME this process resolved the root from
    join(home, DEVICE_DEFAULT_STATE_PATH.slice(2)),
  ]);
  const otherDenies = withCanonicalForms(otherDirs);
  const projectPaths = canonicalProjectPaths(policy.projectPaths);
  return Object.freeze({
    revision: digest({
      generation: version(after),
      policy,
      roots,
      deviceId: input.deviceId,
      projectReach: policy.ownerCeiling.projectReach,
      projectPaths,
      secretAndStateDenies,
      otherConnectionDenies: otherDenies,
      unreadableConnections: unreadable,
    }),
    outsideSandbox: policy.ownerCeiling.outsideSandbox,
    network: policy.ownerCeiling.network,
    allowedDomains: Object.freeze([...policy.allowedDomains]),
    roots,
    projectReach: policy.ownerCeiling.projectReach,
    projectPaths: Object.freeze(projectPaths),
    secretAndStateDenies: Object.freeze(secretAndStateDenies),
    otherConnectionDenies: Object.freeze(otherDenies),
    unreadableConnections: Object.freeze(unreadable),
    restrictedDeniedReadRoots: Object.freeze([
      ...new Set([...secretAndStateDenies, ...otherDenies]),
    ]),
    preparation: Object.freeze({
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    }),
  });
}
/**
 * Each path plus its canonical form (the native real path of its nearest existing ancestor, in
 * its on-disk case so a case variant on a case-insensitive volume matches, with the
 * missing names appended; read as bytes and named like the Linux carve's entries, see
 * `fsNameString`), so a denied path is matched whether a grant names it through a link
 * (a symlinked home, a symlinked ~/.aws) or by its real location.
 */
export function withCanonicalForms(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    out.add(path);
    let anchor = path;
    const missing: string[] = [];
    for (;;) {
      try {
        // as bytes, mapped like the carve's names, so a target that is not UTF-8 still matches
        const real = realpathSync.native(fsNameBytes(anchor), { encoding: "buffer" });
        out.add(join(fsNameString(real), ...missing));
        break;
      } catch {
        if (anchor === dirname(anchor)) break;
        missing.unshift(basename(anchor));
        anchor = dirname(anchor);
      }
    }
  }
  return [...out];
}
/** The English text of each project refusal (operations, and project browsing later). */
export const PROJECT_REFUSAL_MESSAGES: Readonly<Record<DeviceProjectRefusal, string>> =
  Object.freeze({
    "other-connection": "This directory belongs to another connection on this machine.",
    "outside-reach":
      "This directory is outside this connection's project reach (capybara-device ceiling set " +
      "--project-reach, capybara-device policy add projectPaths).",
    denied: "This directory holds secrets or capybara-device's own state.",
  });
/** Why the ceiling refuses `path` (a project root or a scoped root), or null when it allows it. */
export function ceilingPathRefusal(
  path: string,
  ceiling: DeviceOwnerCeiling,
  reach: ProjectReach = ceiling.projectReach,
): DeviceProjectRefusal | null {
  return projectPathRefusal(path, {
    reach,
    projectPaths: ceiling.projectPaths,
    roots: ceiling.roots,
    // the union too, so whatever a grant denies is refused here whichever list holds it
    secretAndStateDenies: [...ceiling.secretAndStateDenies, ...ceiling.restrictedDeniedReadRoots],
    otherConnectionDenies: ceiling.otherConnectionDenies,
  });
}
/**
 * Refuses every sandboxed grant while another connection of this machine cannot be read: its
 * working directory could not be kept out of the sandbox. The message says how to fix it.
 */
export function assertConnectionsReadable(ceiling: DeviceOwnerCeiling): void {
  const first = ceiling.unreadableConnections[0];
  if (first !== undefined) throw new SandboxScopeDeniedError(unreadableConnectionMessage(first));
}
/**
 * Refuses roots the owner ceiling does not allow (and every root while another connection cannot
 * be read, {@link assertConnectionsReadable}): not normalized and absolute, in or through a
 * link into another connection's directory or a denied path, or outside the project reach (paths:
 * a listed path or a device root; workspace: a device root; machine: anywhere not denied); write
 * roots in a system runtime or socket directory or on the read-only skills. Preparation roots
 * (trusted skill and attachment staging) are checked against the denies only.
 */
export function checkRoots(
  read: readonly string[],
  write: readonly string[],
  ceiling: DeviceOwnerCeiling,
  preparation = false,
): void {
  assertConnectionsReadable(ceiling);
  for (const root of [...read, ...write]) {
    if (root !== resolve(root))
      throw new SandboxScopeDeniedError("Supply normalized absolute roots");
    const refusal = ceilingPathRefusal(root, ceiling, preparation ? "machine" : undefined);
    if (refusal !== null) throw new SandboxScopeDeniedError(PROJECT_REFUSAL_MESSAGES[refusal]);
  }
  // the kernel's candidate builder and admission refuse the same roots: another process's socket
  // there would let a sandboxed command act outside the sandbox. Checked before the skills rule so
  // the refusal names the real reason wherever the skills root lives (under /tmp on Linux)
  for (const root of write) {
    const runtime = sandboxRuntimeDirectoryOf(root);
    if (runtime !== null)
      throw new SandboxScopeDeniedError(
        `Write root ${root} is a system runtime or socket directory (${runtime}), where other programs keep their sockets; grant a directory of its own (such as /tmp/<name>) or one inside the project instead`,
      );
  }
  if (
    !preparation &&
    write.some((r) => within(r, ceiling.roots.skills) || within(ceiling.roots.skills, r))
  )
    throw new SandboxScopeDeniedError("Skills remain read only");
}
export function freezeAuthority(a: LocalExecAuthority): LocalExecAuthority {
  if (
    !a.operationId ||
    !["open-public", "allowlist"].includes(a.orgNetwork.kind) ||
    a.orgNetwork.hosts.some((h) => validateAllowHost(h).length > 0)
  )
    throw new SandboxScopeDeniedError("Invalid authenticated execution authority");
  if (
    a.grants &&
    (!["run", "task"].includes(a.grants.source.kind) ||
      !a.grants.source.id ||
      !a.grants.source.accountId ||
      a.grants.hosts.some((h) => h.includes("*") || validateAllowHost(h).length > 0))
  )
    throw new SandboxScopeDeniedError("Invalid authenticated grants");
  return Object.freeze({
    operationId: a.operationId,
    orgNetwork: Object.freeze({
      ...a.orgNetwork,
      hosts: Object.freeze([...a.orgNetwork.hosts]),
    }) as SandboxLimits["network"],
    ...(a.grants
      ? {
          grants: Object.freeze({
            hosts: Object.freeze([...a.grants.hosts]),
            source: Object.freeze({ ...a.grants.source }),
          }) as unknown as DeviceExecGrants,
        }
      : {}),
  });
}
/** The refusal of an escalated call the owner ceiling does not allow. */
export const OUTSIDE_SANDBOX_REFUSAL =
  "Running outside the sandbox is outside the current owner ceiling; the owner allows it on " +
  "this machine with capybara-device ceiling set --outside-sandbox on";

/**
 * One operation's scope intersected with the owner ceiling now (approval-only profiles design).
 * Every profile's ordinary call is sandboxed: the read roots of the connection's project reach,
 * the scope's write roots, the owner's denied read roots and the sandbox network. Only an
 * escalated call (`filesystem: device` with `network: environment`) runs outside the sandbox, and
 * only while the owner ceiling allows `outsideSandbox`. The profile in the scope is audit only: it
 * never widens anything here.
 */
export function intersectOperation(
  scope: SandboxOperationScope,
  ceiling: DeviceOwnerCeiling,
  authority?: LocalExecAuthority,
  native = false,
): LocalOperationGrant {
  if (authority && authority.operationId !== scope.operationId)
    throw new SandboxScopeDeniedError("Execution authority operation ID mismatch");
  const escalated = scope.filesystem.kind === "device" && scope.network.kind === "environment";
  if (escalated) {
    if (!ceiling.outsideSandbox) throw new SandboxScopeDeniedError(OUTSIDE_SANDBOX_REFUSAL);
    return Object.freeze({
      full: true,
      readRoots: Object.freeze(["/"]),
      writeRoots: Object.freeze(["/"]),
      hosts: Object.freeze([]),
      deniedReadRoots: Object.freeze([]),
      revision: ceiling.revision,
    });
  }
  if (scope.filesystem.kind !== "scoped" || scope.network.kind === "environment")
    throw new SandboxScopeDeniedError(
      "The device filesystem and the environment network come only together, as one escalated call",
    );
  // the project root and every write root within the reach and outside every denied directory;
  // what the operation reads is this program's rule (the reach), never the scope
  const fs = scope.filesystem;
  checkRoots(fs.projectRoot === null ? [] : [fs.projectRoot], fs.writeRoots, ceiling);
  const readRoots = readRootsFor({
    reach: ceiling.projectReach,
    projectPaths: ceiling.projectPaths,
    roots: ceiling.roots,
    writeRoots: fs.writeRoots,
  });
  if (!native && !authority)
    throw new SandboxScopeDeniedError("Restricted execution requires authenticated authority");
  let openNetwork = false;
  const hosts = new Set<string>();
  if (authority && !native) {
    const egress = effectiveEgress(
      { ownerCeiling: { network: ceiling.network }, allowedDomains: [...ceiling.allowedDomains] },
      authority.orgNetwork,
      authority.grants,
    );
    if (scope.network.kind === "open-public") {
      // asked for the open network: open only where the owner and the kernel both allow it,
      // otherwise narrowed to the allowlist they do allow
      if (egress.kind === "open-public") openNetwork = true;
      else for (const h of egress.hosts) hosts.add(h);
    } else if (scope.network.kind !== "allowlist") {
      // `none`: no network at all
    } else if (egress.kind === "open-public") {
      for (const h of scope.network.hosts) hosts.add(h.toLowerCase());
    } else {
      for (const a of egress.hosts)
        for (const b of scope.network.hosts) {
          if (covers(a, b)) hosts.add(b);
          else if (covers(b, a)) hosts.add(a);
        }
    }
  }
  return Object.freeze({
    full: false,
    ...(openNetwork && { openNetwork: true }),
    readRoots: Object.freeze(readRoots),
    writeRoots: Object.freeze([...scope.filesystem.writeRoots]),
    hosts: Object.freeze([...hosts]),
    deniedReadRoots: Object.freeze([...ceiling.restrictedDeniedReadRoots]),
    revision: ceiling.revision,
  });
}

/**
 * Whether a live operation's grant still holds against the grant the fresh owner ceiling gives the
 * same scope (owner reconcile): a full grant only while the next one is full; a sandboxed grant
 * only while every host, the open network if it had one, every read root (inside a next read
 * root) and exactly the same denied read roots remain. Anything narrower revokes the operation.
 */
export function grantStillHolds(grant: LocalOperationGrant, next: LocalOperationGrant): boolean {
  if (grant.full) return next.full;
  return (
    !next.full &&
    (!grant.openNetwork || next.openNetwork === true) &&
    grant.readRoots.every((r) => next.readRoots.some((n) => within(r, n))) &&
    grant.hosts.every((h) => next.hosts.includes(h)) &&
    grant.deniedReadRoots.every((r) => next.deniedReadRoots.includes(r)) &&
    next.deniedReadRoots.every((r) => grant.deniedReadRoots.includes(r))
  );
}
