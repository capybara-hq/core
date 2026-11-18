import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import type { Command } from "../args.js";
import { noteCliPolicyChange } from "../command-log.js";
import { PolicyStore } from "../policy-store.js";
import { type Policy, policyPath, readCredential } from "../state.js";

export interface PolicyDeps {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The fields `show` prints and `set` may replace. */
const KEYS = ["allowedDomains", "allowCredentials", "cpu", "memoryMb"] as const;

/** What OS mode does not enforce yet, shown with `show` and with a limits change. */
export const NOT_ENFORCED_NOTE =
  "Note: in OS mode cpu and memoryMb are not enforced yet; allowCredentials is ignored (Full " +
  "access already has the owner's credentials, restricted work gets none).";

/** Where the owner ceiling is changed (the policy command never changes it). */
const CEILING_COMMAND =
  "capybara-device ceiling set --full-access allow|deny --project-reach workspace|os-user";

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

/** What `policy show` says the owner ceiling gives on this machine (English, one line each). */
export function describeCeiling(policy: Policy, runMode: "os" | "docker" = "os"): string[] {
  const { fullAccess, restrictedProjectReach } = policy.ownerCeiling;
  const where = runMode === "docker" ? "in the device's container" : "as you on this machine";
  return [
    fullAccess
      ? `Owner ceiling: Full access allowed: a conversation set to Full access runs commands ${where}.`
      : "Owner ceiling: Full access denied: conversations here use the restricted profiles only.",
    restrictedProjectReach === "os-user"
      ? "Restricted work and project browsing may read projects outside the device's workspace."
      : "Restricted work and project browsing stay in the device's workspace.",
    `Change the owner ceiling with: ${CEILING_COMMAND}`,
  ];
}

/**
 * `policy show` prints the local policy and what its mode gives on this machine;
 * `policy set <key> <value>` replaces one field; `policy add|remove <key> <value>` adds or removes
 * entries of a list field. The owner ceiling is set with `capybara-device ceiling set`. The
 * machine's user edits this file; the deployment changes it only through the `policy` op
 * (narrowing only). Writes take policy.json.lock, and a running program applies the change at its
 * next operation.
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
  const docker = dockerMode(stateDir);
  if (cmd.action === "show") {
    const policy = store.current();
    out(JSON.stringify(policy, null, 2));
    for (const l of describeCeiling(policy, docker ? "docker" : "os")) out(l);
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
        case "mode":
          throw new Error(`the mode is gone: set the owner ceiling with ${CEILING_COMMAND}`);
        case "network":
        case "tier":
        case "isolation":
        case "localhost":
        case "remoteGrants":
          throw new Error(
            `"${key}" is gone: set the owner ceiling with ${CEILING_COMMAND}; ` +
              `allowedDomains with capybara-device policy add allowedDomains <host>`,
          );
        default:
          throw new Error(`unknown policy key "${key}"; one of ${KEYS.join(", ")}`);
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
  try {
    store.update((p) => change(p, (l) => lines.push(l)));
  } catch (e) {
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  // the audit line names the key and the values given, never more (no secret is a policy value)
  noteCliPolicyChange(stateDir, `policy ${action} ${key} ${list(value).join(", ")}`);
  for (const l of lines) out(l);
  out(`Saved ${policyPath(stateDir)}. A running capybara-device applies it at the next operation.`);
  if (key === "allowedDomains") {
    out("Restricted work may reach these domains when the organization allows them too.");
  }
  if (key === "cpu" || key === "memoryMb" || key === "allowCredentials") out(NOT_ENFORCED_NOTE);
  return 0;
}
