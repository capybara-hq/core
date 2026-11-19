import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  type DeviceExecGrants,
  type DeviceNetworkMode,
  type SandboxLimits,
  type SandboxOperationScope,
  type SandboxRoots,
  SandboxScopeDeniedError,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { covers, deniedSecretPaths, effectiveEgress } from "../policy.js";
import { policyPath, readPolicyFile } from "../state.js";
import { osRoots } from "./shared.js";

/**
 * The owner ceiling as this program enforces it: the fields of the protocol's
 * `DeviceOwnerCeilingV3` (the device sandbox for every profile) plus the local facts the
 * intersection needs (roots, denied read roots, preparation roots).
 */
export interface DeviceOwnerCeiling {
  readonly revision: string;
  /** Whether a call may be granted escalation outside the sandbox (device + environment). */
  readonly outsideSandbox: boolean;
  /** The sandbox network: the open public internet or the {@link allowedDomains} allowlist. */
  readonly network: DeviceNetworkMode;
  readonly allowedDomains: readonly string[];
  readonly roots: Readonly<SandboxRoots>;
  readonly restrictedProjectReach: "workspace" | "os-user";
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
/** Strict additive reader: no absent-file defaults or last-good fallback. */
export async function readStrictOwnerCeiling(input: {
  stateDir: string;
  deviceId: string;
  dir: string;
  home?: string;
}): Promise<DeviceOwnerCeiling> {
  return readStrictOwnerCeilingSync(input);
}
/**
 * {@link readStrictOwnerCeiling}, synchronously (the owner report issues it under the policy lock).
 * Only a version-3 policy file is authority: an old format is refused until it is converted.
 */
export function readStrictOwnerCeilingSync(input: {
  stateDir: string;
  deviceId: string;
  dir: string;
  home?: string;
}): DeviceOwnerCeiling {
  const file = policyPath(input.stateDir);
  const before = statSync(file);
  if (!before.isFile()) throw new SandboxScopeDeniedError("Owner policy must be a regular file");
  const read = readPolicyFile(input.stateDir);
  if (read.legacy)
    throw new SandboxScopeDeniedError(
      "Owner policy is in the old format; restart capybara-device or run capybara-device ceiling set to convert it",
    );
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
  return Object.freeze({
    revision: digest({ generation: version(after), policy, roots, deviceId: input.deviceId }),
    outsideSandbox: policy.ownerCeiling.outsideSandbox,
    network: policy.ownerCeiling.network,
    allowedDomains: Object.freeze([...policy.allowedDomains]),
    roots,
    restrictedProjectReach: policy.ownerCeiling.restrictedProjectReach,
    restrictedDeniedReadRoots: Object.freeze(
      withCanonicalForms([...deniedSecretPaths(input.home ?? homedir()), resolve(input.stateDir)]),
    ),
    preparation: Object.freeze({
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    }),
  });
}
/**
 * Each path plus its canonical form (the real path of its nearest existing ancestor with the
 * missing names appended), so a denied path is matched whether a grant names it through a link
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
        out.add(join(realpathSync(anchor), ...missing));
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
export function checkRoots(
  read: readonly string[],
  write: readonly string[],
  ceiling: DeviceOwnerCeiling,
  preparation = false,
): void {
  for (const root of [...read, ...write]) {
    if (root !== resolve(root))
      throw new SandboxScopeDeniedError("Supply normalized absolute roots");
    if (
      !preparation &&
      ceiling.restrictedProjectReach === "workspace" &&
      !Object.values(ceiling.roots).some((r) => within(root, r))
    )
      throw new SandboxScopeDeniedError("Root exceeds the current workspace owner ceiling");
    if (ceiling.restrictedDeniedReadRoots.some((r) => within(root, r)))
      throw new SandboxScopeDeniedError("Root is denied by the owner");
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
 * Every profile's ordinary call is sandboxed: scoped roots, the owner's denied read roots and the
 * sandbox network. Only an escalated call (`filesystem: device` with `network: environment`) runs
 * outside the sandbox, and only while the owner ceiling allows `outsideSandbox`. The profile in the
 * scope is audit only: it never widens anything here.
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
  checkRoots(scope.filesystem.readRoots, scope.filesystem.writeRoots, ceiling);
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
    readRoots: Object.freeze([...scope.filesystem.readRoots]),
    writeRoots: Object.freeze([...scope.filesystem.writeRoots]),
    hosts: Object.freeze([...hosts]),
    deniedReadRoots: Object.freeze([...ceiling.restrictedDeniedReadRoots]),
    revision: ceiling.revision,
  });
}

/**
 * Whether a live operation's grant still holds against the grant the fresh owner ceiling gives the
 * same scope (owner reconcile): a full grant only while the next one is full; a sandboxed grant
 * only while every host, the open network if it had one, and exactly the same denied read roots
 * remain. Anything narrower revokes the operation.
 */
export function grantStillHolds(grant: LocalOperationGrant, next: LocalOperationGrant): boolean {
  if (grant.full) return next.full;
  return (
    !next.full &&
    (!grant.openNetwork || next.openNetwork === true) &&
    grant.hosts.every((h) => next.hosts.includes(h)) &&
    grant.deniedReadRoots.every((r) => next.deniedReadRoots.includes(r)) &&
    next.deniedReadRoots.every((r) => grant.deniedReadRoots.includes(r))
  );
}
