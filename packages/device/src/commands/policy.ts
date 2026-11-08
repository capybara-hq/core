import { validateAllowHost } from "@capybara-hq/plugin-sdk";
import type { Command } from "../args.js";
import { type Policy, policyPath, readPolicy, writePolicy } from "../state.js";

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

/**
 * `policy show` prints the local policy; `policy set <key> <value>` changes one field. Only the
 * machine's user edits this file: the cloud never writes it. Changes apply at the next start.
 */
export function policyCommand(
  cmd: Extract<Command, { command: "policy" }>,
  deps: PolicyDeps,
): number {
  const { stateDir, out, err } = deps;
  let policy: Policy;
  try {
    policy = readPolicy(stateDir);
  } catch (e) {
    err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  if (cmd.action === "show") {
    out(JSON.stringify(policy, null, 2));
    out(NOT_ENFORCED_NOTE);
    return 0;
  }
  const { key, value } = cmd;
  const next: Policy = { ...policy };
  try {
    switch (key) {
      case "allowedDomains": {
        const domains = list(value).map((d) => d.toLowerCase());
        for (const d of domains) {
          const errors = validateAllowHost(d);
          if (errors.length > 0) throw new Error(`"${d}": ${errors.join("; ")}`);
        }
        next.allowedDomains = [...new Set(domains)];
        break;
      }
      case "allowCredentials":
        next.allowCredentials = [...new Set(list(value))];
        break;
      case "cpu":
      case "memoryMb":
        next[key] = ceiling(key, value);
        break;
      default:
        throw new Error(`unknown policy key "${key}"; one of ${KEYS.join(", ")}`);
    }
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  writePolicy(stateDir, next);
  out(`Saved ${policyPath(stateDir)}. Restart capybara-device for it to take effect.`);
  out(NOT_ENFORCED_NOTE);
  return 0;
}
