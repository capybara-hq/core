import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DeviceExecGrants,
  type SandboxLimits,
  type SandboxRoots,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { Policy } from "./state.js";

/**
 * Paths no command may read (spec §13.6, extended by ruling R19): SSH keys, cloud CLI
 * credentials, container and Kubernetes credentials, netrc, GnuPG, git / npm / PyPI tokens, the
 * macOS keychains, and the browser profile directories (Chrome, Firefox, Chromium, Safari, Brave,
 * Edge, Arc). Relative to `~`.
 */
export const DENIED_SECRET_PATHS: readonly string[] = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.gnupg",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Firefox",
  "~/.mozilla",
  "~/.config/google-chrome",
  "~/.config/chromium",
  // Ruling R19: more credential stores and browser data.
  "~/.config/gh",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  "~/Library/Keychains",
  "~/Library/Cookies",
  "~/Library/Safari",
  "~/Library/Application Support/BraveSoftware",
  "~/Library/Application Support/Microsoft Edge",
  "~/Library/Application Support/Arc",
  "~/.config/BraveSoftware",
  "~/.config/microsoft-edge",
]);

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

/**
 * The entry {@link effectiveEgress} returns when a command may reach any public host (the device
 * is `open` and so is the org). sandbox-runtime 0.0.81 matches `*` as any host but refuses it in a
 * per-command list, so the OS executor never registers it: its ask callback allows instead.
 */
export const ANY_HOST = "*";

type Limits = Pick<SandboxLimits, "egress" | "allowHosts">;

/**
 * The granted hosts that apply to one command: none unless the local `remoteGrants` is `owner`;
 * only valid exact hosts (no wildcards, addresses or internal names), lowercased and deduped; and
 * only those the org's egress admits (any host when it is `open`, none when it is `none`).
 */
export function grantedHosts(
  policy: Pick<Policy, "remoteGrants">,
  limits: Limits,
  grants: Pick<DeviceExecGrants, "hosts"> | undefined,
): string[] {
  if (grants === undefined || policy.remoteGrants !== "owner") return [];
  if (limits.egress === "none") return [];
  const out = new Set<string>();
  for (const raw of grants.hosts) {
    if (typeof raw !== "string") continue;
    const host = raw.toLowerCase();
    if (host.startsWith("*.") || validateAllowHost(host).length > 0) continue;
    if (limits.egress === "open" || limits.allowHosts.some((p) => covers(p.toLowerCase(), host))) {
      out.add(host);
    }
  }
  return [...out];
}

/**
 * The domains one command may reach: what the device's egress allows, cut to the local policy,
 * plus the command's grants ({@link grantedHosts}). The cloud can only narrow the local policy;
 * an empty `allowlist` policy allows nothing but the grants. A policy `open` stops narrowing: the
 * org's list, or {@link ANY_HOST} when the org is open too.
 */
export function effectiveEgress(
  policy: Pick<Policy, "allowedDomains" | "network" | "remoteGrants">,
  limits: Limits,
  grants?: Pick<DeviceExecGrants, "hosts">,
): string[] {
  if (limits.egress === "none") return [];
  if (policy.network === "open") {
    if (limits.egress === "open") return [ANY_HOST];
    return [...new Set(limits.allowHosts.map((h) => h.toLowerCase()))];
  }
  const local = policy.allowedDomains.map((d) => d.toLowerCase());
  const out = new Set<string>();
  if (limits.egress === "open") {
    for (const d of local) out.add(d);
  } else {
    for (const raw of limits.allowHosts) {
      const host = raw.toLowerCase();
      for (const p of local) {
        // The intersection of two entries is the narrower one, if either contains the other.
        if (covers(p, host)) out.add(host);
        else if (covers(host, p)) out.add(p);
      }
    }
  }
  for (const h of grantedHosts(policy, limits, grants)) out.add(h);
  return [...out];
}

/** The sandbox-runtime configuration of one device. */
export interface SrtConfig {
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
}

/**
 * The sandbox-runtime configuration: writes only under the workspace and tmp roots (the runtime's
 * implicit write paths denied), skills read only, the secret paths (plus `opts.denyRead`, such as this program's own state directory)
 * unreadable, and network limited to `egress`.
 */
export function srtConfig(
  _policy: Policy,
  roots: SandboxRoots,
  egress: string[],
  opts: { home?: string; denyRead?: string[] } = {},
): SrtConfig {
  return {
    filesystem: {
      denyRead: [...deniedSecretPaths(opts.home), ...(opts.denyRead ?? [])],
      allowWrite: [roots.workspace, roots.tmp],
      denyWrite: [roots.skills, ...implicitWritePaths()],
    },
    network: { allowedDomains: [...egress], deniedDomains: [] },
  };
}
