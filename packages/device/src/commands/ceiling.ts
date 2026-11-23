import type { Command } from "../args.js";
import { noteCliPolicyChange } from "../command-log.js";
import { scanConnections } from "../connections.js";
import { machineReachMountRefusal } from "../exec/linux-mountinfo.js";
import { readStrictOwnerCeilingSync } from "../exec/operation-types.js";
import { reachWidens } from "../exec/read-model.js";
import { PolicyStore } from "../policy-store.js";
import {
  type OwnerCeilingPolicy,
  POLICY_VERSION,
  type Policy,
  PolicyVersionError,
  policyFormatName,
  policyPath,
  readCredential,
  replacementPolicy,
} from "../state.js";
import { connectionFlag } from "./policy.js";

/** Printed once when `ceiling set` replaced a policy file in another format version. */
export function policyReplacedNotice(replaced: PolicyVersionError, stateDir: string): string {
  return (
    `Replaced ${replaced.file} (format ${policyFormatName(replaced.found)}, this program reads ` +
    `format ${POLICY_VERSION}): allowed domains, credentials, resource limits and keep-awake are ` +
    `back to their defaults; set them again with capybara-device policy / keep-awake${connectionFlag(stateDir)}.`
  );
}

/** Printed before a widening is applied (by --yes or a confirmed prompt). */
export const CEILING_WIDENING_TEXT =
  "Widening this machine's owner ceiling lets the deployment ask for more here. Commands always " +
  "run in the sandbox under every profile, Full access included. Allowing outside the sandbox " +
  "lets one approved call run as you, with your files, credentials and any network: the person, " +
  "the review model, or a Full access auto-grant approves each such call, and each one is " +
  "recorded. The open network lets sandboxed commands reach the public internet (private, local " +
  "and metadata addresses stay closed). The machine reach lets sandboxed work read the whole " +
  "machine except secrets, this program's state and other connections; the paths reach only the " +
  "listed project paths. Conversations need fresh Full access consent either way.";

/** Printed after {@link CEILING_WIDENING_TEXT} when outside the sandbox turns on beside others. */
export const CEILING_OTHER_CONNECTIONS_TEXT =
  "Other connections exist on this machine: a call outside the sandbox runs as you and can read " +
  "their working directories and state.";

export const CEILING_NEEDS_YES =
  "Nothing changed. To widen the owner ceiling, add --yes (or answer y at the prompt).";

export const CEILING_PROMPT = "Widen this machine's owner ceiling? [y/N] ";

export interface CeilingDeps {
  stateDir: string;
  /** The program state root (every connection's state), as the CLI computes it. */
  stateRoot: string;
  home: string;
  out: (line: string) => void;
  err: (line: string) => void;
  ask?: (question: string) => Promise<string>;
  /** Test seam: runs after the unlocked read, before the locked write. */
  beforeWrite?: () => void;
}

/** The strict reader's revision for the logged-in device, or null (logged out, unreadable). */
function strictRevision(stateDir: string, stateRoot: string, home: string): string | null {
  try {
    const cred = readCredential(stateDir);
    if (cred === undefined) return null;
    return readStrictOwnerCeilingSync({
      stateDir,
      stateRoot,
      deviceId: cred.deviceId,
      dir: cred.dir,
      home,
    }).revision;
  } catch {
    return null;
  }
}

/** Thrown inside the locked update when the policy now on disk makes the target a widening. */
class WideningNeedsConfirmation extends Error {
  constructor(
    readonly cur: OwnerCeilingPolicy,
    readonly next: OwnerCeilingPolicy,
  ) {
    super("widening needs confirmation");
  }
}

const describe = (p: Policy): string[] => [
  `Outside the sandbox: ${p.ownerCeiling.outsideSandbox ? "on" : "off"}`,
  `Network: ${p.ownerCeiling.network}`,
  `Project reach: ${
    p.ownerCeiling.projectReach === "paths"
      ? `paths (${p.projectPaths.length} listed)`
      : p.ownerCeiling.projectReach
  }`,
];

/**
 * True when this machine has more than one connection directory (readable, unreadable or logged
 * out: a logged-out one's leftover state and working directory are reachable outside the sandbox
 * too); a connections directory that cannot be listed counts as having others (fail closed).
 */
function otherConnectionsExist(stateRoot: string): boolean {
  try {
    const { readable, unreadable, credentialless } = scanConnections(stateRoot);
    return readable.length + unreadable.length + credentialless.length > 1;
  } catch {
    return true;
  }
}

/** The widening text, and the other-connections sentence when `next` turns outside the sandbox on. */
function wideningLines(
  cur: OwnerCeilingPolicy,
  next: OwnerCeilingPolicy,
  stateRoot: string,
): string[] {
  return !cur.outsideSandbox && next.outsideSandbox && otherConnectionsExist(stateRoot)
    ? [CEILING_WIDENING_TEXT, CEILING_OTHER_CONNECTIONS_TEXT]
    : [CEILING_WIDENING_TEXT];
}

/** True when `next` allows anything `cur` does not. */
export function widens(cur: OwnerCeilingPolicy, next: OwnerCeilingPolicy): boolean {
  return (
    (!cur.outsideSandbox && next.outsideSandbox) ||
    (cur.network === "allowlist" && next.network === "open") ||
    reachWidens(cur.projectReach, next.projectReach)
  );
}

/** The target ceiling: the fields the command names, the others as they are in `cur`. */
function target(
  cmd: Extract<Command, { command: "ceiling"; action: "set" }>,
  cur: OwnerCeilingPolicy,
): OwnerCeilingPolicy {
  return {
    outsideSandbox: cmd.outsideSandbox ?? cur.outsideSandbox,
    network: cmd.network ?? cur.network,
    projectReach: cmd.projectReach ?? cur.projectReach,
  };
}

/**
 * `ceiling show` prints the owner ceiling, the sandbox allowlist and the revision; `ceiling set`
 * changes the named fields under the policy lock, the others as they are then. A policy file in
 * another format version is replaced by `ceiling set`: the named fields over the closed policy,
 * a widening of it confirmed as any other.
 * Narrowing applies directly; widening needs --yes or a confirmed terminal answer. Only the
 * machine's owner widens it: the deployment may only narrow.
 */
export async function ceilingCommand(
  cmd: Extract<Command, { command: "ceiling" }>,
  deps: CeilingDeps,
): Promise<number> {
  const { stateDir, out, err } = deps;
  let store: PolicyStore;
  // `ceiling set` on a file in another format version starts from the replacement policy
  try {
    store = new PolicyStore(stateDir);
  } catch (e) {
    if (!(cmd.action === "set" && e instanceof PolicyVersionError)) {
      err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
      return 1;
    }
    store = new PolicyStore(stateDir, { initial: replacementPolicy() });
  }
  const cur = store.current();
  if (cmd.action === "show" && cmd.json === true) {
    out(
      JSON.stringify({
        outsideSandbox: cur.ownerCeiling.outsideSandbox,
        network: cur.ownerCeiling.network,
        allowedDomains: cur.allowedDomains,
        projectReach: cur.ownerCeiling.projectReach,
        projectPaths: cur.projectPaths,
        // the strict reader's digest of the policy generation; null while logged out
        revision: strictRevision(stateDir, deps.stateRoot, deps.home),
      }),
    );
    return 0;
  }
  if (cmd.action === "show") {
    for (const line of describe(cur)) out(line);
    out(
      `Sandbox allowlist: ${cur.allowedDomains.length > 0 ? cur.allowedDomains.join(", ") : "none"}` +
        (cur.ownerCeiling.network === "open" ? " (used while the network is an allowlist)" : ""),
    );
    const cred = (() => {
      try {
        return readCredential(stateDir);
      } catch {
        return undefined;
      }
    })();
    if (cred !== undefined) {
      try {
        const strict = readStrictOwnerCeilingSync({
          stateDir,
          stateRoot: deps.stateRoot,
          deviceId: cred.deviceId,
          dir: cred.dir,
          home: deps.home,
        });
        out(`Revision: ${strict.revision}`);
        if (strict.mountReexposureProblem !== null)
          out(`Mounts: ${machineReachMountRefusal(strict.mountReexposureProblem)}`);
      } catch (e) {
        out(`Revision: unavailable (${(e as Error).message})`);
      }
    }
    out(
      "The platform and organization sandbox settings and this machine's runtime support apply " +
        "separately; the deployment's device page shows the effective permissions.",
    );
    return 0;
  }
  let confirmed = cmd.yes === true;
  const wanted = target(cmd, cur.ownerCeiling);
  if (widens(cur.ownerCeiling, wanted)) {
    for (const line of wideningLines(cur.ownerCeiling, wanted, deps.stateRoot)) out(line);
    if (!confirmed) {
      if (deps.ask === undefined) {
        err(CEILING_NEEDS_YES);
        return 2;
      }
      const answer = (await deps.ask(CEILING_PROMPT)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        err("Nothing changed.");
        return 1;
      }
      confirmed = true;
    }
  }
  deps.beforeWrite?.();
  let written: Policy;
  let replaced: PolicyVersionError | undefined;
  try {
    // decided again on the policy under the lock: a narrowing that landed since the read above
    // makes this a widening, which needs its own confirmation
    written = store.update(
      (p) => {
        const next = target(cmd, p.ownerCeiling);
        if (!confirmed && widens(p.ownerCeiling, next))
          throw new WideningNeedsConfirmation(p.ownerCeiling, next);
        return { ...p, ownerCeiling: next };
      },
      {
        onOtherVersion: (e) => {
          replaced = e;
        },
      },
    );
  } catch (e) {
    if (e instanceof WideningNeedsConfirmation) {
      for (const line of wideningLines(e.cur, e.next, deps.stateRoot)) out(line);
      err(`The owner ceiling changed meanwhile. ${CEILING_NEEDS_YES}`);
      return 2;
    }
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  const ceiling = written.ownerCeiling;
  noteCliPolicyChange(
    stateDir,
    `ceiling set outsideSandbox ${ceiling.outsideSandbox ? "on" : "off"}, network ` +
      `${ceiling.network}, projectReach ${ceiling.projectReach}`,
  );
  if (replaced !== undefined) out(policyReplacedNotice(replaced, stateDir));
  out("This machine's owner ceiling is now:");
  for (const line of describe(written)) out(line);
  if (ceiling.network === "allowlist")
    out(
      "Sandboxed commands reach only the sandbox allowlist (capybara-device policy add " +
        `allowedDomains <host>${connectionFlag(stateDir)}).`,
    );
  if (ceiling.projectReach === "machine")
    out(
      "Sandboxed work may read the whole machine except secrets, this program's state and other " +
        "connections.",
    );
  if (ceiling.projectReach === "paths")
    out("Sandboxed work may read the listed project paths outside the device's workspace.");
  if (ceiling.projectReach === "paths" && written.projectPaths.length === 0)
    out(
      `No project paths are listed yet: capybara-device policy add projectPaths <dir>${connectionFlag(stateDir)}`,
    );
  return 0;
}
