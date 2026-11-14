import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DeviceExecGrants,
  type SandboxLimits,
  type SandboxRoots,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { Policy, SandboxMode } from "./state.js";

/**
 * Paths no sandboxed command may read (spec §13.6, extended by ruling R19): SSH keys, cloud CLI
 * credentials, container and Kubernetes credentials, netrc, GnuPG, git / npm / PyPI tokens, the
 * macOS keychains, and the browser profile directories (Chrome, Firefox, Chromium, Safari, Brave,
 * Edge, Arc). Relative to `~`. Auto mode runs as the owner and does not apply them: command review
 * in the kernel does (spec §5.2).
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

/** The limits fields that decide the mode and the sandbox-mode network. */
export type ModeLimits = Pick<SandboxLimits, "mode" | "network">;

/**
 * The mode a command runs in (spec §4.1): the device's own choice cut to the kernel's ceiling. A
 * sandbox-mode machine never runs auto because the organization allows it; an auto-mode machine in
 * an organization that forbids auto runs in the sandbox (and its summary says so).
 */
export function effectiveMode(
  policy: Pick<Policy, "mode">,
  limits: Pick<SandboxLimits, "mode">,
): SandboxMode {
  return policy.mode === "sandbox" || limits.mode === "sandbox" ? "sandbox" : "auto";
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
  policy: Pick<Policy, "allowedDomains" | "mode">,
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

/** The sandbox-runtime configuration of a sandbox-mode device. */
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

/** What {@link srtConfig} needs besides the egress list. */
export interface SrtConfigOptions {
  /** The home whose secret paths are denied (default: the user's home). */
  home?: string;
  /** More paths commands may not read (this program's state directory). */
  denyRead?: string[];
}

/** Characters the sandbox runtime reads as a glob in a path entry. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Write denies for git under each writable root (spec §5.2.1): `.git/hooks` and `.git/config`
 * (a hook or `core.sshCommand` set by a command would run when the owner later runs git there).
 * The runtime has the same mandatory denies, but anchored at this program's own working directory,
 * which may not contain the roots. A root whose path reads as a glob gets none (it cannot be
 * anchored literally); the runtime's own denies still apply when it lies under the working
 * directory.
 */
function gitWriteDenies(writable: string[]): string[] {
  const out: string[] = [];
  for (const root of writable) {
    if (GLOB_CHARS.test(root)) continue;
    out.push(`${root}/.git/hooks/**`, `${root}/**/.git/hooks/**`);
    out.push(`${root}/.git/config`, `${root}/**/.git/config`);
  }
  return out;
}

/**
 * The sandbox-runtime configuration of sandbox mode (spec §4.1, §4.4): today's strict profile
 * only. Writes only under the workspace and tmp roots (the runtime's implicit write paths
 * denied), skills read only, the secret paths (plus `opts.denyRead`, such as this program's own
 * state directory) unreadable, and network limited to `egress`. No local binding, no unix sockets.
 */
export function srtConfig(
  roots: SandboxRoots,
  egress: string[],
  opts: SrtConfigOptions = {},
): SrtConfig {
  const allowWrite = [roots.workspace, roots.tmp];
  return {
    filesystem: {
      denyRead: [...deniedSecretPaths(opts.home), ...(opts.denyRead ?? [])],
      allowWrite,
      denyWrite: [roots.skills, ...implicitWritePaths(opts.home), ...gitWriteDenies(allowWrite)],
    },
    network: {
      allowedDomains: [...egress],
      deniedDomains: [],
    },
  };
}
