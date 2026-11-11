import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import type { Command } from "../args.js";
import { PolicyStore } from "../policy-store.js";
import { type Policy, policyPath } from "../state.js";

export interface PolicyDeps {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const KEYS = ["allowedDomains", "allowCredentials", "cpu", "memoryMb"] as const;

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
  if (action === "add") {
    const next = [...current];
    for (const v of values) {
      if (next.includes(v)) out(`${v} is already in ${key}.`);
      else {
        next.push(v);
        out(`Added ${v} to ${key}.`);
      }
    }
    return next;
  }
  const drop = new Set(values);
  for (const v of values)
    out(current.includes(v) ? `Removed ${v} from ${key}.` : `${v} is not in ${key}.`);
  return current.filter((v) => !drop.has(v));
}

/**
 * `policy show` prints the local policy; `policy set <key> <value>` replaces one field;
 * `policy add|remove <key> <value>` adds or removes entries of a list field. The machine's user
 * edits this file; the cloud never writes it. Writes take policy.json.lock, and a running
 * program applies the change at its next command.
 */
export function policyCommand(
  cmd: Extract<Command, { command: "policy" }>,
  deps: PolicyDeps,
): number {
  const { stateDir, out, err } = deps;
  let store: PolicyStore;
  try {
    store = new PolicyStore(stateDir);
  } catch (e) {
    err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  if (cmd.action === "show") {
    out(JSON.stringify(store.current(), null, 2));
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
        default:
          throw new Error(`unknown policy key "${key}"; one of ${KEYS.join(", ")}`);
      }
    } else {
      if (!(LIST_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${action} works on ${LIST_KEYS.join(" and ")} only; use set for ${key}`);
      }
      const listKey = key as ListKey;
      const values = listKey === "allowedDomains" ? domains(value) : list(value);
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
  for (const l of lines) out(l);
  out(`Saved ${policyPath(stateDir)}. A running capybara-device applies it at the next command.`);
  if (key !== "allowedDomains") out(NOT_ENFORCED_NOTE);
  return 0;
}
