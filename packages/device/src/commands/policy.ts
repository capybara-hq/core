import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEVICE_DEFAULT_STATE_PATH,
  type SandboxRoots,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import type { Command } from "../args.js";
import { noteCliPolicyChange } from "../command-log.js";
import { scanConnections } from "../connections.js";
import { readStrictOwnerCeilingSync, withCanonicalForms, within } from "../exec/operation-types.js";
import {
  otherConnectionDenies,
  projectPathRefusal,
  unreadableConnectionMessage,
  withFirmlinkForms,
} from "../exec/read-model.js";
import { osRoots } from "../exec/shared.js";
import { deniedSecretPaths } from "../policy.js";
import { PolicyStore } from "../policy-store.js";
import { type Policy, policyPath, readCredential } from "../state.js";

export interface PolicyDeps {
  stateDir: string;
  /** The program state root (every connection's state), as the CLI computes it. */
  stateRoot: string;
  home: string;
  /** What a relative project path resolves against; default the process's working directory. */
  cwd?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The fields `show` prints and `set` may replace. */
const KEYS = ["allowedDomains", "allowCredentials", "cpu", "memoryMb", "projectPaths"] as const;

/** What OS mode does not enforce yet, shown with `show` and with a limits change. */
export const NOT_ENFORCED_NOTE =
  "Note: in OS mode cpu and memoryMb are not enforced yet; allowCredentials is ignored (a call " +
  "outside the sandbox already has the owner's credentials, sandboxed work gets none).";

/** Where the owner ceiling is changed (the policy command never changes it). */
const CEILING_COMMAND =
  "capybara-device ceiling set --outside-sandbox on|off --network open|allowlist " +
  "--project-reach machine|paths|workspace";

/** Printed with a projectPaths change while the reach is not `paths`. */
const PROJECT_PATHS_REACH_NOTE =
  "Project paths apply while the project reach is paths (capybara-device ceiling set " +
  "--project-reach paths).";

/** Printed instead in Docker mode, where sandboxed work runs in the device's container. */
const PROJECT_PATHS_DOCKER_NOTE =
  "Project paths do not apply in Docker mode: sandboxed work runs in the device's container.";

/** Printed when an added project path contains a denied directory. */
const PROJECT_PATHS_INNER_DENY_NOTE =
  "Secrets, capybara-device's own state and other connections inside it stay unreadable.";

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
const LIST_KEYS = ["allowedDomains", "allowCredentials", "projectPaths"] as const;
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

/**
 * The real paths of the project paths given (relative ones against `cwd`), deduplicated; throws
 * naming the first that is missing, not a directory, or one sandboxed work may never read (a
 * secret path, this program's state, another connection's directory). Only the deny lists decide
 * (the machine reach); they are checked again at every operation. `containsDenied`: one of them
 * holds a denied directory (which stays unreadable).
 */
function projectPaths(
  value: string,
  deps: PolicyDeps,
): { paths: string[]; containsDenied: boolean } {
  const { stateDir, stateRoot, home } = deps;
  const given = list(value);
  // Logged in: the owner ceiling's deny lists. Logged out: secrets, this program's state and the
  // other connections' directories. Either way an unreadable connection refuses (fail closed: its
  // directory cannot be kept out).
  let denies: { secretAndStateDenies: readonly string[]; otherConnectionDenies: readonly string[] };
  // The device roots matter only under the paths and workspace reaches, never under the machine
  // reach checked here. Logged in: the connection's own (its device directory). Logged out there is
  // no device directory: roots inside the denied state directory, which could never widen.
  let roots: Readonly<SandboxRoots>;
  const cred = readCredential(stateDir);
  if (cred !== undefined) {
    let ceiling: ReturnType<typeof readStrictOwnerCeilingSync>;
    try {
      ceiling = readStrictOwnerCeilingSync({
        stateDir,
        stateRoot,
        deviceId: cred.deviceId,
        dir: cred.dir,
        home,
      });
    } catch (e) {
      throw new Error(
        `Cannot check project paths against the owner ceiling: ${(e as Error).message}`,
      );
    }
    const unreadable = ceiling.unreadableConnections[0];
    if (unreadable !== undefined) throw new Error(unreadableConnectionMessage(unreadable));
    denies = ceiling;
    roots = ceiling.roots;
  } else {
    let others: string[];
    try {
      const scan = scanConnections(stateRoot);
      const unreadable = [
        ...scan.unreadable,
        ...scan.readable
          .filter((c) => !isAbsolute(c.workDir))
          .map((c) => ({ deviceId: c.deviceId, reason: "its working directory is not absolute" })),
      ][0];
      if (unreadable !== undefined) throw new Error(unreadableConnectionMessage(unreadable));
      // logged out, so every connection is another one
      others = otherConnectionDenies({
        ownDeviceId: "",
        connections: scan.readable,
        credentialless: scan.credentialless,
        home: resolve(home),
      });
    } catch (e) {
      throw new Error(
        `Cannot check project paths against the connections: ${(e as Error).message}`,
      );
    }
    denies = {
      secretAndStateDenies: [
        ...deniedSecretPaths(home),
        stateDir,
        stateRoot,
        join(home, DEVICE_DEFAULT_STATE_PATH.slice(2)),
      ],
      otherConnectionDenies: others,
    };
    roots = osRoots(resolve(stateDir));
  }
  const allDenies = withCanonicalForms(
    [...denies.secretAndStateDenies, ...denies.otherConnectionDenies].map((d) => resolve(d)),
  );
  const noteDenies = withFirmlinkForms(allDenies);
  let containsDenied = false;
  const out: string[] = [];
  for (const entry of given) {
    const path = resolve(deps.cwd ?? process.cwd(), entry);
    let real: string;
    try {
      real = realpathSync.native(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${path} does not exist`);
      throw new Error(`Cannot read ${path}: ${(e as Error).message}`);
    }
    if (!statSync(real).isDirectory()) throw new Error(`${path} is not a directory`);
    if (real === "/") {
      throw new Error(
        '"/" is not a project path: use capybara-device ceiling set --project-reach machine',
      );
    }
    const refusal = projectPathRefusal(real, {
      reach: "machine",
      projectPaths: [],
      roots,
      ...denies,
    });
    if (refusal === "denied") {
      throw new Error(
        `${path} holds secrets or this program's state; sandboxed work never reads it`,
      );
    }
    if (refusal === "other-connection") {
      throw new Error(`${path} belongs to another connection of this machine`);
    }
    if (refusal !== null) throw new Error(`${path} cannot be a project path (${refusal})`);
    // the note matches a firmlink spelling (/System/Volumes/Data/...) as the refusal does
    const reals = withFirmlinkForms([real]);
    if (reals.some((r) => noteDenies.some((d) => d !== r && within(d, r)))) containsDenied = true;
    if (!out.includes(real)) out.push(real);
  }
  return { paths: out, containsDenied };
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
  const { outsideSandbox, network, projectReach } = policy.ownerCeiling;
  const where = runMode === "docker" ? "in the device's container" : "as you on this machine";
  return [
    "Commands run in the sandbox under every profile, Full access included.",
    outsideSandbox
      ? `Owner ceiling: outside the sandbox on: one approved call may run ${where}.`
      : "Owner ceiling: outside the sandbox off: no call runs outside the sandbox here.",
    network === "open"
      ? "Sandbox network: open (the public internet; private, local and metadata addresses stay closed)."
      : "Sandbox network: allowlist (allowedDomains only).",
    projectReach === "machine"
      ? "Sandboxed work and project browsing read the whole machine except secrets, this " +
        "program's state and other connections."
      : projectReach === "paths"
        ? "Sandboxed work and project browsing read the device's workspace and the projectPaths list."
        : "Sandboxed work and project browsing stay in the device's workspace.",
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
  let containsDenied = false;
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
        case "projectPaths": {
          const checked = projectPaths(value, deps);
          const next = checked.paths;
          containsDenied = checked.containsDenied;
          change = (p) => ({ ...p, projectPaths: next });
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
      let values: string[];
      if (listKey === "projectPaths" && action === "add") {
        const checked = projectPaths(value, deps);
        values = checked.paths;
        containsDenied = checked.containsDenied;
      } else if (listKey === "allowedDomains") {
        values = action === "add" ? domains(value) : list(value).map((d) => d.toLowerCase());
      } else {
        values = list(value);
      }
      if (values.length === 0) throw new Error(`${action} needs at least one value`);
      change = (p, say) => ({ ...p, [listKey]: edit(p[listKey], action, listKey, values, say) });
    }
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  const lines: string[] = [];
  let saved: Policy;
  try {
    saved = store.update((p) => change(p, (l) => lines.push(l)));
  } catch (e) {
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  // the audit line names the key and the values given, never more (no secret is a policy value)
  noteCliPolicyChange(stateDir, `policy ${action} ${key} ${list(value).join(", ")}`);
  for (const l of lines) out(l);
  out(`Saved ${policyPath(stateDir)}. A running capybara-device applies it at the next operation.`);
  if (key === "allowedDomains") {
    out(
      "Sandboxed work may reach these domains while the network is an allowlist, when the " +
        "organization allows them too.",
    );
  }
  if (key === "projectPaths") {
    if (containsDenied) out(PROJECT_PATHS_INNER_DENY_NOTE);
    if (docker) out(PROJECT_PATHS_DOCKER_NOTE);
    else if (saved.ownerCeiling.projectReach !== "paths") out(PROJECT_PATHS_REACH_NOTE);
  }
  if (key === "cpu" || key === "memoryMb" || key === "allowCredentials") out(NOT_ENFORCED_NOTE);
  return 0;
}
