import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DeviceExecGrants,
  minTier,
  type SandboxLimits,
  type SandboxRoots,
  type SandboxTier,
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

/** The tier fields of an exec's limits: the org's ceiling and its default. */
export type TierLimits = Pick<SandboxLimits, "tier" | "defaultTier">;

/**
 * The tier this device runs a command at (spec §4.4): the owner's choice, or the org's default
 * when there is none (`strict` when the kernel sent no default either), cut to the ceiling the
 * kernel sends in `limits.tier`.
 */
export function deviceTier(policy: Pick<Policy, "tier">, limits: TierLimits): SandboxTier {
  return minTier(policy.tier ?? limits.defaultTier ?? "strict", limits.tier);
}

/**
 * The tier before any exec was seen (no ceiling known yet): the owner's choice, else `dev`, the
 * default of every org unless changed. Used for the sandbox's first configuration only; the next
 * command applies its own limits.
 */
export function provisionalTier(policy: Pick<Policy, "tier">): SandboxTier {
  return policy.tier ?? "dev";
}

/** What a tier really gives on this machine (the device page and `policy show`). */
export interface TierFacts {
  effectiveTier: SandboxTier;
  /** Whether sandboxed commands may listen on and reach localhost. */
  localhost: "on" | "off-proxy-detected" | "off";
  /** Unix sockets: within the device's directories, every socket with the host's masked, none. */
  unixSockets: "roots" | "all-masked" | "off";
}

/**
 * The facts of the device's tier (spec §5.2.3, §7.3). `limits` undefined means no exec was seen
 * yet: the owner's choice, else `dev`, uncapped. `isolation: none` is reported separately (these
 * describe the sandboxed tier).
 *
 * - Docker mode: the container has its own loopback and sockets in every tier.
 * - OS mode, Linux: the sandbox has its own network namespace, so its loopback always works (not
 *   reachable from the host); unix sockets stay blocked (srt cannot limit them by path there).
 * - OS mode, macOS: `strict` has neither; `dev` / `open` get unix sockets under the device's
 *   directories and localhost unless a local forwarding proxy was detected and the owner did not
 *   set `localhost: allow`.
 */
export function tierFacts(
  policy: Policy,
  limits: TierLimits | undefined,
  opts: { platform?: NodeJS.Platform; proxyDetected: boolean; mode: "os" | "docker" },
): TierFacts {
  const effectiveTier = limits === undefined ? provisionalTier(policy) : deviceTier(policy, limits);
  if (opts.mode === "docker") return { effectiveTier, localhost: "on", unixSockets: "all-masked" };
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return { effectiveTier, localhost: "on", unixSockets: "off" };
  if (effectiveTier === "strict") return { effectiveTier, localhost: "off", unixSockets: "off" };
  return {
    effectiveTier,
    localhost: localBinding(policy, opts.proxyDetected) ? "on" : "off-proxy-detected",
    unixSockets: "roots",
  };
}

/** macOS `dev` / `open`: local binding, unless a local proxy was found and not overridden. */
function localBinding(policy: Pick<Policy, "localhost">, proxyDetected: boolean): boolean {
  return policy.localhost === "allow" || !proxyDetected;
}

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

/** The limits {@link effectiveEgress} reads: the ceiling's network and tiers, and the dev hosts. */
export type EgressLimits = Pick<
  SandboxLimits,
  "egress" | "allowHosts" | "tier" | "defaultTier" | "devHosts"
>;

/**
 * The hosts the device itself admits at `tier` (before the ceiling): its `allowedDomains`, plus
 * the dev hosts in `dev`. Undefined for `open`: the device admits every host.
 */
export function deviceHosts(
  policy: Pick<Policy, "allowedDomains">,
  tier: SandboxTier,
  devHosts: readonly string[],
): string[] | undefined {
  if (tier === "open") return undefined;
  const local = policy.allowedDomains.map((d) => d.toLowerCase());
  if (tier === "dev") for (const d of devHosts) local.push(d.toLowerCase());
  return [...new Set(local)];
}

/**
 * The domains one command may reach (spec §4.2), with `t` = {@link deviceTier} and the ceiling's
 * hosts (`limits.allowHosts`, or any host when `limits.egress` is `open`):
 * - `strict`: ceiling ∩ `allowedDomains` (an empty list allows nothing but the grants);
 * - `dev`: ceiling ∩ (`allowedDomains` ∪ `limits.devHosts`);
 * - `open`: the ceiling itself ({@link ANY_HOST} when it is `open`);
 * plus the command's grants ({@link grantedHosts}). The cloud can only narrow the local policy.
 */
export function effectiveEgress(
  policy: Pick<Policy, "allowedDomains" | "tier" | "remoteGrants">,
  limits: EgressLimits,
  grants?: Pick<DeviceExecGrants, "hosts">,
): string[] {
  if (limits.egress === "none") return [];
  const local = deviceHosts(policy, deviceTier(policy, limits), limits.devHosts ?? []);
  if (local === undefined) {
    if (limits.egress === "open") return [ANY_HOST];
    return [...new Set(limits.allowHosts.map((h) => h.toLowerCase()))];
  }
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
    /** Whether commands may write `.git/config` (`dev` / `open`); `.git/hooks` never. */
    allowGitConfig: boolean;
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    /** macOS: bind and accept on local ports, connect to any port on localhost. */
    allowLocalBinding: boolean;
    /** macOS only: the paths under which unix sockets may be bound and connected to. */
    allowUnixSockets?: string[];
  };
}

/** What {@link srtConfig} needs besides the policy and the roots. */
export interface SrtConfigOptions {
  /** The tier the commands run at (default `strict`). */
  tier?: SandboxTier;
  /** The home whose secret paths are denied (default: the user's home). */
  home?: string;
  /** More paths commands may not read (this program's state directory). */
  denyRead?: string[];
  platform?: NodeJS.Platform;
  /** The proxy guard found a local forwarding proxy (macOS `dev` / `open` then skip localhost). */
  proxyDetected?: boolean;
  /** macOS: the short socket directory (`TMPDIR` in `dev` / `open`). */
  socketDir?: string;
  /** The device's package caches (`<dir>/cache`), writable in `dev` / `open`. */
  cacheDir?: string;
}

/** Characters the sandbox runtime reads as a glob in a path entry. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Write denies for git under each writable root (spec §5.2.1): `.git/hooks` at every tier (a hook
 * is code that runs unsandboxed when the owner later runs git there), `.git/config` at `strict`.
 * The runtime has the same mandatory denies, but anchored at this program's own working directory,
 * which may not contain the roots. A root whose path reads as a glob gets none (it cannot be
 * anchored literally); the runtime's own denies still apply when it lies under the working
 * directory.
 */
function gitWriteDenies(writable: string[], gitConfig: boolean): string[] {
  const out: string[] = [];
  for (const root of writable) {
    if (GLOB_CHARS.test(root)) continue;
    out.push(`${root}/.git/hooks/**`, `${root}/**/.git/hooks/**`);
    if (!gitConfig) out.push(`${root}/.git/config`, `${root}/**/.git/config`);
  }
  return out;
}

/**
 * The sandbox-runtime configuration (spec §5.1, §5.2.3): writes only under the workspace and tmp
 * roots (the runtime's implicit write paths denied), skills read only, the secret paths (plus
 * `opts.denyRead`, such as this program's own state directory) unreadable, and network limited to
 * `egress`.
 *
 * `strict` stops there: no local binding, no unix sockets. `dev` and `open` also write the
 * package caches and (macOS) the short socket directory; on macOS they may listen on and reach
 * localhost unless the proxy guard found a local forwarding proxy (`localhost: allow` overrides)
 * and use unix sockets under the tmp root, the workspace and the socket directory. On Linux unix
 * sockets stay blocked (srt can only allow all of them there, the host daemons' included) and the
 * sandbox's own network namespace gives it a loopback anyway. `allowAllUnixSockets` is never set.
 * `dev` and `open` may write `.git/config` (so git can init, clone, set remotes and config);
 * `.git/hooks` stays unwritable at every tier ({@link gitWriteDenies}).
 */
export function srtConfig(
  policy: Policy,
  roots: SandboxRoots,
  egress: string[],
  opts: SrtConfigOptions = {},
): SrtConfig {
  const platform = opts.platform ?? process.platform;
  const tier = opts.tier ?? "strict";
  const darwin = platform === "darwin";
  const dev = tier !== "strict";
  const socketDir = darwin && dev ? opts.socketDir : undefined;
  const allowWrite = [
    roots.workspace,
    roots.tmp,
    ...(socketDir !== undefined ? [socketDir] : []),
    ...(dev && opts.cacheDir !== undefined ? [opts.cacheDir] : []),
  ];
  return {
    filesystem: {
      denyRead: [...deniedSecretPaths(opts.home), ...(opts.denyRead ?? [])],
      allowWrite,
      denyWrite: [roots.skills, ...implicitWritePaths(), ...gitWriteDenies(allowWrite, dev)],
      allowGitConfig: dev,
    },
    network: {
      allowedDomains: [...egress],
      deniedDomains: [],
      allowLocalBinding: darwin && dev && localBinding(policy, opts.proxyDetected === true),
      ...(darwin &&
        dev && {
          allowUnixSockets: [
            roots.tmp,
            roots.workspace,
            ...(socketDir !== undefined ? [socketDir] : []),
          ],
        }),
    },
  };
}
