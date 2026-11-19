import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_DENIED_SECRET_PATHS,
  type DeviceExecGrants,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { OwnerCeilingPolicy, Policy } from "./state.js";

/**
 * Paths no sandboxed command may read: the SDK's {@link DEVICE_DENIED_SECRET_PATHS} (one source
 * with the kernel, which never proposes an approval under one). Relative to `~`.
 */
export const DENIED_SECRET_PATHS: readonly string[] = DEVICE_DENIED_SECRET_PATHS;

/** {@link DENIED_SECRET_PATHS} with `~` expanded to `home`. */
export function deniedSecretPaths(home: string = homedir()): string[] {
  return DENIED_SECRET_PATHS.map((p) => join(home, p.slice(2)));
}

/**
 * Paths sandbox-runtime makes writable without being asked (its own temp directory and two home
 * convenience directories). They lie outside the device directory, so they are denied.
 */
export function implicitWritePaths(home: string = homedir()): string[] {
  return [
    "/tmp/claude",
    "/private/tmp/claude",
    join(home, ".npm/_logs"),
    join(home, ".claude/debug"),
  ];
}

/** True when the allowlist entry `pattern` admits every host `host` names (`host` may be a wildcard). */
export function covers(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  // `*.x.com` admits `a.x.com` and `*.a.x.com`, never the apex `x.com`.
  return pattern.startsWith("*.") && host.endsWith(pattern.slice(1));
}

/** The granted hosts that apply to one command, within the kernel's network limits. */
export function grantedHosts(
  limits: Pick<SandboxLimits, "network">,
  grants: Pick<DeviceExecGrants, "hosts"> | undefined,
): string[] {
  if (grants === undefined) return [];
  const out = new Set<string>();
  for (const raw of grants.hosts) {
    if (typeof raw !== "string") continue;
    const host = raw.toLowerCase();
    // Only valid exact public hosts (no wildcards, addresses or internal names).
    if (validateAllowHost(host).length > 0) continue;
    if (
      limits.network.kind === "open-public" ||
      limits.network.hosts.some((p) => covers(p.toLowerCase(), host))
    ) {
      out.add(host);
    }
  }
  return [...out];
}

/** The network one sandboxed command may reach: the open public internet or an allowlist. */
export type SandboxEgress =
  | { readonly kind: "open-public" }
  | { readonly kind: "allowlist"; readonly hosts: string[] };

/**
 * The network one sandboxed command may reach (approval-only profiles design, "Settings model"):
 * the owner's network ceiling intersected with the kernel's authenticated network, plus the
 * command's grants.
 *
 * - Owner `open` and kernel `open-public`: the open public internet (the address classes the
 *   design closes stay closed by the workers).
 * - Owner `open` and a kernel allowlist: the kernel's hosts.
 * - Owner `allowlist`: the owner's `allowedDomains`, cut to the kernel's allowlist when it has one.
 *
 * Granted hosts are added within the kernel's network ({@link grantedHosts}). An empty allowlist
 * allows nothing.
 */
export function effectiveEgress(
  policy: Pick<Policy, "allowedDomains"> & { ownerCeiling: Pick<OwnerCeilingPolicy, "network"> },
  orgNetwork: SandboxLimits["network"],
  grants?: Pick<DeviceExecGrants, "hosts">,
): SandboxEgress {
  const limits = { network: orgNetwork };
  if (policy.ownerCeiling.network === "open") {
    if (orgNetwork.kind === "open-public") return { kind: "open-public" };
    const out = new Set(orgNetwork.hosts.map((h) => h.toLowerCase()));
    for (const h of grantedHosts(limits, grants)) out.add(h);
    return { kind: "allowlist", hosts: [...out] };
  }
  const out = new Set<string>();
  const local = policy.allowedDomains.map((d) => d.toLowerCase());
  const orgHosts =
    orgNetwork.kind === "allowlist" ? orgNetwork.hosts.map((h) => h.toLowerCase()) : local;
  for (const host of orgHosts) {
    for (const p of local) {
      // The intersection of two entries is the narrower one, if either contains the other.
      if (covers(p, host)) out.add(host);
      else if (covers(host, p)) out.add(p);
    }
  }
  for (const h of grantedHosts(limits, grants)) out.add(h);
  return { kind: "allowlist", hosts: [...out] };
}
