import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_DENIED_SECRET_PATHS,
  type DeviceExecGrants,
  type SandboxLimits,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { type Policy, policyMode, type SandboxMode } from "./state.js";

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

/** The limits fields that decide the mode and the sandbox-mode network. */
export type ModeLimits = Pick<SandboxLimits, "mode" | "network">;

/**
 * The mode a command runs in (spec §4.1): the device's own choice cut to the kernel's ceiling. A
 * sandbox-mode machine never runs auto because the organization allows it; an auto-mode machine in
 * an organization that forbids auto runs in the sandbox (and its summary says so).
 */
export function effectiveMode(
  policy: Pick<Policy, "ownerCeiling">,
  limits: Pick<SandboxLimits, "mode">,
): SandboxMode {
  return policyMode(policy) === "sandbox" || limits.mode === "sandbox" ? "sandbox" : "auto";
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

/**
 * The domains one sandbox-mode command may reach (spec §4.1, §4.4): the intersection of the
 * device's own `allowedDomains` and the kernel's allowlist (`limits.network`), plus the command's
 * grants. An empty list allows nothing. Auto mode ignores both lists: the command has the machine's
 * own network, so this returns no list there (the OS sandbox is not running).
 */
export function effectiveEgress(
  policy: Pick<Policy, "allowedDomains" | "ownerCeiling">,
  limits: ModeLimits,
  grants?: Pick<DeviceExecGrants, "hosts">,
): string[] {
  if (effectiveMode(policy, limits) === "auto") return [];
  const out = new Set<string>();
  const local = policy.allowedDomains.map((d) => d.toLowerCase());
  // `open-public` is for cloud instances only; a local sandbox-mode device is stricter and keeps
  // its own allowlist.
  const orgHosts =
    limits.network.kind === "allowlist" ? limits.network.hosts.map((h) => h.toLowerCase()) : local;
  for (const host of orgHosts) {
    for (const p of local) {
      // The intersection of two entries is the narrower one, if either contains the other.
      if (covers(p, host)) out.add(host);
      else if (covers(host, p)) out.add(p);
    }
  }
  for (const h of grantedHosts(limits, grants)) out.add(h);
  return [...out];
}
