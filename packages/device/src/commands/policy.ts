import { isSandboxTier, type SandboxTier, validateAllowHost } from "@capybara-hq/plugin-sdk";
import type { Command } from "../args.js";
import { type TierFacts, tierFacts } from "../policy.js";
import { PolicyStore } from "../policy-store.js";
import { detectLocalProxy, type ProxyGuardResult } from "../proxy-guard.js";
import { type Policy, policyPath, readCredential } from "../state.js";

export interface PolicyDeps {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * The person already read the risk text and answered `y` at the prompt ({@link confirmRisk});
   * otherwise `set tier open` and `set isolation none` need `--yes`.
   */
  confirmed?: boolean;
  /** The localhost proxy guard `show` runs (default: {@link detectLocalProxy}). */
  detectProxy?: () => Promise<ProxyGuardResult>;
  platform?: NodeJS.Platform;
}

const KEYS = [
  "allowedDomains",
  "allowCredentials",
  "cpu",
  "memoryMb",
  "tier",
  "isolation",
  "localhost",
  "remoteGrants",
] as const;

/** Shown before `set tier open` takes effect (adapted from the network ask-to-allow spec §7). */
export const OPEN_TIER_RISK =
  "At tier open, agent commands on this device can reach any address the organization allows " +
  "(any public address if the organization has no limit), including uploading files to " +
  "outside sites. Prompt injection can make an agent do that. Turn it on only on your own " +
  "development machine, with agents and material you trust.";

/** Shown before `set isolation none` takes effect (spec §5.4). */
export const UNSANDBOXED_RISK_TEXT =
  "Without a sandbox, agent commands run on this computer as you: they can read and write all " +
  "your files, use your credentials (SSH keys, cloud accounts, keychain), Docker and any " +
  "network. Prompt injection can make an agent delete files or send your credentials away. " +
  "Turn it on only on your own development machine, with agents and material you fully trust.";

/** A change that asks first: its risk text, the prompt, and the refusal without a confirmation. */
export interface PolicyRisk {
  risk: string;
  prompt: string;
  needsYes: string;
}

const OPEN_TIER: PolicyRisk = {
  risk: OPEN_TIER_RISK,
  prompt: "Let commands on this device reach any address the organization allows? [y/N] ",
  needsYes: "Nothing changed. To set tier open, run: capybara-device policy set tier open --yes",
};

const UNSANDBOXED: PolicyRisk = {
  risk: UNSANDBOXED_RISK_TEXT,
  prompt: "Run agent commands on this computer without a sandbox? [y/N] ",
  needsYes:
    "Nothing changed. To run commands without a sandbox, run: " +
    "capybara-device policy set isolation none --yes",
};

/** The risk of a `policy` command line, when it is one of the changes that ask first. */
export function policyRisk(cmd: Extract<Command, { command: "policy" }>): PolicyRisk | undefined {
  if (cmd.action !== "set") return undefined;
  const value = cmd.value.trim().toLowerCase();
  if (cmd.key === "tier" && value === "open") return OPEN_TIER;
  if (cmd.key === "isolation" && value === "none") return UNSANDBOXED;
  return undefined;
}

/** `set tier open` or `set isolation none` without `--yes`: the changes that ask first. */
export function needsConfirmation(cmd: Extract<Command, { command: "policy" }>): boolean {
  return cmd.action === "set" && policyRisk(cmd) !== undefined && cmd.yes !== true;
}

/**
 * Asks on a terminal before a change that needs it: prints its risk text and the prompt; true
 * only for an answer of `y` or `yes`.
 */
export async function confirmRisk(
  cmd: Extract<Command, { command: "policy" }>,
  deps: { out: (line: string) => void; ask: (question: string) => Promise<string> },
): Promise<boolean> {
  const r = policyRisk(cmd);
  if (r === undefined) return true;
  deps.out(r.risk);
  const answer = (await deps.ask(r.prompt)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** @deprecated Use {@link needsConfirmation}; kept until cli.ts switches. */
export const needsOpenConfirmation = needsConfirmation;

/** @deprecated Use {@link confirmRisk}; kept until cli.ts switches (asks for tier open). */
export function confirmOpenNetwork(deps: {
  out: (line: string) => void;
  ask: (question: string) => Promise<string>;
}): Promise<boolean> {
  return confirmRisk({ command: "policy", action: "set", key: "tier", value: "open" }, deps);
}

/** @deprecated Use {@link policyRisk}'s `needsYes`; kept until cli.ts switches. */
export const OPEN_NETWORK_NEEDS_YES = OPEN_TIER.needsYes;

/** What the OS mode does not enforce yet, shown with every `show` and `set`. */
export const NOT_ENFORCED_NOTE =
  "Note: in OS mode cpu and memoryMb are not enforced yet, and allowCredentials is not used: " +
  "commands get no local credentials.";

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function ceiling(key: string, value: string): number | null {
  if (value === "none" || value === "null") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number or none, got "${value}"`);
  }
  return n;
}

/** Shown when a docker-mode device is given an allowed domain. */
export const DOCKER_NETWORK_NOTE =
  "Note: this device runs commands in Docker mode, which cannot limit network access per " +
  "domain: while any domain is allowed or the tier is open (and the organization allows " +
  "network), commands reach the whole internet. Use OS mode to allow single domains.";

/** Shown when a Docker-mode device is told to run commands without a sandbox. */
export const DOCKER_ISOLATION_REFUSED =
  "This device runs commands in Docker mode, where they always run in a container; " +
  "isolation none works in OS mode only.";

/** Whether this machine is logged in in Docker mode (false when unknown). */
function dockerMode(stateDir: string): boolean {
  try {
    return readCredential(stateDir)?.mode === "docker";
  } catch {
    return false;
  }
}

/** The keys `add` and `remove` work on: the list fields. */
const LIST_KEYS = ["allowedDomains", "allowCredentials"] as const;
type ListKey = (typeof LIST_KEYS)[number];

/** Lowercased, validated hosts; throws naming the first bad one. */
function domains(value: string): string[] {
  const out = list(value).map((d) => d.toLowerCase());
  for (const d of out) {
    const errors = validateAllowHost(d);
    if (errors.length > 0) throw new Error(`"${d}": ${errors.join("; ")}`);
  }
  return out;
}

/** The new value of a list field after `add` / `remove`; unchanged entries are reported. */
function edit(
  current: readonly string[],
  action: "add" | "remove",
  key: ListKey,
  values: string[],
  out: (line: string) => void,
): string[] {
  // Domains compare ignoring case (a hand-edited file may hold any spelling).
  const norm = key === "allowedDomains" ? (v: string) => v.toLowerCase() : (v: string) => v;
  const has = (list: readonly string[], v: string) => list.some((x) => norm(x) === norm(v));
  if (action === "add") {
    const next = [...current];
    for (const v of values) {
      if (has(next, v)) out(`${v} is already in ${key}.`);
      else {
        next.push(v);
        out(`Added ${v} to ${key}.`);
      }
    }
    return next;
  }
  for (const v of values)
    out(has(current, v) ? `Removed ${v} from ${key}.` : `${v} is not in ${key}.`);
  return current.filter((x) => !has(values, x));
}

function tierValue(value: string): SandboxTier | undefined {
  const v = value.trim().toLowerCase();
  if (v === "default") return undefined;
  if (!isSandboxTier(v))
    throw new Error(`tier must be strict, dev, open or default, got "${value}"`);
  return v;
}

/** What `policy show` says the tier gives on this machine (English, one line each). */
export function describeTier(policy: Policy, facts: TierFacts, proxy: ProxyGuardResult): string[] {
  const chosen =
    policy.tier !== undefined
      ? `${policy.tier} (set on this device; the organization's ceiling may lower it)`
      : "the organization's default (dev unless the organization changed it)";
  const lines = [`Tier: ${chosen}.`];
  const localhost =
    facts.localhost === "on"
      ? "commands can listen on local ports and reach this machine's localhost"
      : facts.localhost === "off-proxy-detected"
        ? `off: a local proxy was detected (${proxy.reasons.join("; ")}). Commands could ` +
          "reach past the network allowlist through it. To allow localhost anyway, run: " +
          "capybara-device policy set localhost allow"
        : "off";
  lines.push(`At tier ${facts.effectiveTier} on this machine: localhost ${localhost}.`);
  const sockets =
    facts.unixSockets === "roots"
      ? "allowed under the device's workspace, tmp and socket directories only"
      : facts.unixSockets === "all-masked"
        ? "the container's own"
        : "blocked";
  lines.push(`Unix sockets: ${sockets}.`);
  if (facts.effectiveTier !== "strict") {
    lines.push("Package caches are kept in the device directory's cache folder.");
  }
  if (policy.isolation === "none") {
    lines.push(
      "Isolation: none. While the tier is open, commands run directly on this computer as you, " +
        "without a sandbox. To turn the sandbox back on, run: " +
        "capybara-device policy set isolation sandbox",
    );
  }
  return lines;
}

/**
 * `policy show` prints the local policy and what its tier gives on this machine;
 * `policy set <key> <value>` replaces one field (`set tier open` and `set isolation none` print
 * their risk and need `--yes` or a confirmation at the prompt); `policy add|remove <key> <value>`
 * adds or removes entries of a list field. `tier default` removes the key (follow the org's
 * default). The machine's user edits this file; the deployment changes it only through the
 * `policy` op, on the device owner's decision and only while `remoteGrants` is `owner`
 * (narrowing always; never `isolation none`). Writes take policy.json.lock, and a running program
 * applies the change at its next command.
 */
export async function policyCommand(
  cmd: Extract<Command, { command: "policy" }>,
  deps: PolicyDeps,
): Promise<number> {
  const { stateDir, out, err } = deps;
  let store: PolicyStore;
  try {
    store = new PolicyStore(stateDir);
  } catch (e) {
    err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  if (cmd.action === "show") {
    const policy = store.current();
    out(JSON.stringify(policy, null, 2));
    const proxy = await (deps.detectProxy ?? (() => detectLocalProxy()))();
    const facts = tierFacts(policy, undefined, {
      ...(deps.platform !== undefined && { platform: deps.platform }),
      proxyDetected: proxy.detected,
      mode: dockerMode(stateDir) ? "docker" : "os",
    });
    for (const l of describeTier(policy, facts, proxy)) out(l);
    out(NOT_ENFORCED_NOTE);
    return 0;
  }
  const { action, key, value } = cmd;
  // Parse and validate before taking the lock; apply inside it, against the file as it is then.
  let change: (p: Policy, say: (line: string) => void) => Policy;
  try {
    if (action === "set") {
      switch (key) {
        case "allowedDomains": {
          const next = [...new Set(domains(value))];
          change = (p) => ({ ...p, allowedDomains: next });
          break;
        }
        case "allowCredentials": {
          const next = [...new Set(list(value))];
          change = (p) => ({ ...p, allowCredentials: next });
          break;
        }
        case "cpu":
        case "memoryMb": {
          const next = ceiling(key, value);
          change = (p) => ({ ...p, [key]: next });
          break;
        }
        case "tier": {
          const next = tierValue(value);
          change = (p) => {
            const { tier: _old, ...rest } = p;
            return next === undefined ? rest : { ...rest, tier: next };
          };
          break;
        }
        case "isolation": {
          const v = value.trim().toLowerCase();
          if (v !== "sandbox" && v !== "none") {
            throw new Error(`isolation must be sandbox or none, got "${value}"`);
          }
          if (v === "none" && dockerMode(stateDir)) {
            err(DOCKER_ISOLATION_REFUSED);
            return 2;
          }
          change = (p) => ({ ...p, isolation: v });
          break;
        }
        case "localhost": {
          const v = value.trim().toLowerCase();
          if (v !== "auto" && v !== "allow") {
            throw new Error(`localhost must be auto or allow, got "${value}"`);
          }
          change = (p) => ({ ...p, localhost: v });
          break;
        }
        case "remoteGrants": {
          if (value !== "owner" && value !== "off") {
            throw new Error(`remoteGrants must be owner or off, got "${value}"`);
          }
          change = (p) => ({ ...p, remoteGrants: value });
          break;
        }
        case "network":
          throw new Error(
            "network is replaced by tier: use capybara-device policy set tier strict|dev|open",
          );
        default:
          throw new Error(`unknown policy key "${key}"; one of ${KEYS.join(", ")}`);
      }
      // Widening to tier open or isolation none needs a confirmation; narrowing never does.
      const risk = policyRisk(cmd);
      if (risk !== undefined && deps.confirmed !== true) {
        out(risk.risk);
        if (cmd.yes !== true) {
          err(risk.needsYes);
          return 2;
        }
      }
    } else {
      if (!(LIST_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${action} works on ${LIST_KEYS.join(" and ")} only; use set for ${key}`);
      }
      const listKey = key as ListKey;
      // Only additions are validated: any entry already in the file can be removed.
      const values =
        listKey !== "allowedDomains"
          ? list(value)
          : action === "add"
            ? domains(value)
            : list(value).map((d) => d.toLowerCase());
      if (values.length === 0) throw new Error(`${action} needs at least one value`);
      change = (p, say) => ({ ...p, [listKey]: edit(p[listKey], action, listKey, values, say) });
    }
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const lines: string[] = [];
  let next: Policy;
  try {
    next = store.update((p) => change(p, (l) => lines.push(l)));
  } catch (e) {
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  for (const l of lines) out(l);
  out(`Saved ${policyPath(stateDir)}. A running capybara-device applies it at the next command.`);
  const docker = dockerMode(stateDir);
  if (key === "allowedDomains" && action !== "remove" && docker) {
    if (next.allowedDomains.length > 0) out(DOCKER_NETWORK_NOTE);
  }
  if (key === "tier") {
    out(
      next.tier === undefined
        ? "This device now follows the organization's default tier."
        : `This device now asks for tier ${next.tier}; the organization's ceiling may lower it.`,
    );
    if (next.tier === "open" && docker) out(DOCKER_NETWORK_NOTE);
  }
  if (key === "isolation") {
    out(
      next.isolation === "none"
        ? "While the tier is open, commands run on this computer without a sandbox." +
            (next.tier === "open"
              ? ""
              : " The tier is not open yet: run capybara-device policy set tier open --yes.")
        : "Commands run in the sandbox.",
    );
  }
  if (key === "localhost") {
    out(
      next.localhost === "allow"
        ? "At tier dev or open, commands can reach this machine's localhost even when a local " +
            "proxy runs (it may forward past the network allowlist)."
        : "At tier dev or open, commands reach localhost unless a local proxy is detected.",
    );
  }
  if (key === "remoteGrants") {
    out(
      value === "owner"
        ? "The device owner can now widen this device's network from the web or a chat card."
        : "The deployment can no longer widen this device's network; it can still narrow it.",
    );
  }
  if (!["allowedDomains", "tier", "isolation", "localhost", "remoteGrants"].includes(key)) {
    out(NOT_ENFORCED_NOTE);
  }
  return 0;
}
