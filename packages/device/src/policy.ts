import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxLimits, SandboxRoots } from "@capybara-hq/plugin-sdk";
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
function covers(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  // `*.x.com` admits `a.x.com` and `*.a.x.com`, never the apex `x.com`.
  return pattern.startsWith("*.") && host.endsWith(pattern.slice(1));
}

/**
 * The domains one command may reach: what the device's egress allows, cut to the local
 * policy. The cloud can only narrow it: an empty policy allows nothing, whatever the egress.
 */
export function effectiveEgress(
  policy: Pick<Policy, "allowedDomains">,
  limits: Pick<SandboxLimits, "egress" | "allowHosts">,
): string[] {
  const local = policy.allowedDomains.map((d) => d.toLowerCase());
  if (limits.egress === "none") return [];
  if (limits.egress === "open") return [...new Set(local)];
  const out = new Set<string>();
  for (const raw of limits.allowHosts) {
    const host = raw.toLowerCase();
    for (const p of local) {
      // The intersection of two entries is the narrower one, if either contains the other.
      if (covers(p, host)) out.add(host);
      else if (covers(host, p)) out.add(p);
    }
  }
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
