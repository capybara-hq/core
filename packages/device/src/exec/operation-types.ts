import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type DeviceExecGrants,
  type SandboxLimits,
  type SandboxOperationScope,
  type SandboxRoots,
  SandboxScopeDeniedError,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { covers, deniedSecretPaths, effectiveEgress } from "../policy.js";
import { policyPath, readPolicyFile, SANDBOX_OWNER_CEILING } from "../state.js";
import { osRoots } from "./shared.js";

export interface DeviceOwnerCeiling {
  readonly revision: string;
  readonly fullAccess: boolean;
  readonly roots: Readonly<SandboxRoots>;
  readonly restrictedProjectReach: "workspace" | "os-user";
  readonly restrictedAllowedDomains: readonly string[];
  readonly restrictedDeniedReadRoots: readonly string[];
  readonly preparation: Readonly<{ skillsRoot: string; attachmentsBase: string }>;
  readonly fullNetwork: "environment";
}
export interface LocalExecAuthority {
  readonly operationId: string;
  readonly orgNetwork: SandboxLimits["network"];
  readonly grants?: DeviceExecGrants;
}
export interface LocalOperationGrant {
  readonly full: boolean;
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
 * Only a version-2 policy file is authority: an old format is refused until it is converted.
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
    fullAccess: policy.ownerCeiling.fullAccess,
    roots,
    restrictedProjectReach: policy.ownerCeiling.restrictedProjectReach,
    restrictedAllowedDomains: Object.freeze([...policy.allowedDomains]),
    restrictedDeniedReadRoots: Object.freeze([
      ...deniedSecretPaths(input.home ?? homedir()),
      resolve(input.stateDir),
    ]),
    preparation: Object.freeze({
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    }),
    fullNetwork: "environment",
  });
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
export function intersectOperation(
  scope: SandboxOperationScope,
  ceiling: DeviceOwnerCeiling,
  authority?: LocalExecAuthority,
  native = false,
): LocalOperationGrant {
  if (authority && authority.operationId !== scope.operationId)
    throw new SandboxScopeDeniedError("Execution authority operation ID mismatch");
  const full = scope.filesystem.kind === "device" && scope.network.kind === "environment";
  if (full) {
    if (!ceiling.fullAccess)
      throw new SandboxScopeDeniedError("Full access is outside the current owner ceiling");
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
      "Expanded device/environment authority requires the independent Full ceiling",
    );
  checkRoots(scope.filesystem.readRoots, scope.filesystem.writeRoots, ceiling);
  if (!native && !authority)
    throw new SandboxScopeDeniedError("Restricted execution requires authenticated authority");
  const hosts = new Set<string>();
  if (authority && !native && scope.network.kind === "allowlist") {
    const baseline = effectiveEgress(
      {
        ownerCeiling: SANDBOX_OWNER_CEILING,
        allowedDomains: [...ceiling.restrictedAllowedDomains],
      },
      { mode: "sandbox", network: authority.orgNetwork },
      authority.grants,
    );
    for (const a of baseline)
      for (const b of scope.network.hosts) {
        if (covers(a, b)) hosts.add(b);
        else if (covers(b, a)) hosts.add(a);
      }
  }
  return Object.freeze({
    full: false,
    readRoots: Object.freeze([...scope.filesystem.readRoots]),
    writeRoots: Object.freeze([...scope.filesystem.writeRoots]),
    hosts: Object.freeze([...hosts]),
    deniedReadRoots: Object.freeze([...ceiling.restrictedDeniedReadRoots]),
    revision: ceiling.revision,
  });
}
