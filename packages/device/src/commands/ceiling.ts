import type { Command } from "../args.js";
import { noteCliPolicyChange } from "../command-log.js";
import { readStrictOwnerCeilingSync } from "../exec/operation-types.js";
import { PolicyStore } from "../policy-store.js";
import { type OwnerCeilingPolicy, policyPath, readCredential } from "../state.js";

/** Printed before a widening is applied (by --yes or a confirmed prompt). */
export const CEILING_WIDENING_TEXT =
  "Widening this machine's owner ceiling lets the deployment ask for more here. Commands always " +
  "run in the sandbox under every profile, Full access included. Allowing outside the sandbox " +
  "lets one approved call run as you, with your files, credentials and any network: the person, " +
  "the review model, or a Full access auto-grant approves each such call, and each one is " +
  "recorded. The open network lets sandboxed commands reach the public internet (private, local " +
  "and metadata addresses stay closed). The os-user project reach lets sandboxed work and " +
  "project browsing read projects outside the device's workspace. Conversations need fresh Full " +
  "access consent either way.";

export const CEILING_NEEDS_YES =
  "Nothing changed. To widen the owner ceiling, add --yes (or answer y at the prompt).";

export const CEILING_PROMPT = "Widen this machine's owner ceiling? [y/N] ";

export interface CeilingDeps {
  stateDir: string;
  home: string;
  out: (line: string) => void;
  err: (line: string) => void;
  ask?: (question: string) => Promise<string>;
  /** Test seam: runs after the unlocked read, before the locked write. */
  beforeWrite?: () => void;
}

/** The strict reader's revision for the logged-in device, or null (logged out, unreadable). */
function strictRevision(stateDir: string, home: string): string | null {
  try {
    const cred = readCredential(stateDir);
    if (cred === undefined) return null;
    return readStrictOwnerCeilingSync({ stateDir, deviceId: cred.deviceId, dir: cred.dir, home })
      .revision;
  } catch {
    return null;
  }
}

/** Thrown inside the locked update when the policy now on disk makes the target a widening. */
class WideningNeedsConfirmation extends Error {}

const describe = (c: OwnerCeilingPolicy): string[] => [
  `Outside the sandbox: ${c.outsideSandbox ? "on" : "off"}`,
  `Network: ${c.network}`,
  `Project reach: ${c.restrictedProjectReach}`,
];

/** True when `next` allows anything `cur` does not. */
export function widens(cur: OwnerCeilingPolicy, next: OwnerCeilingPolicy): boolean {
  return (
    (!cur.outsideSandbox && next.outsideSandbox) ||
    (cur.network === "allowlist" && next.network === "open") ||
    (cur.restrictedProjectReach === "workspace" && next.restrictedProjectReach === "os-user")
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
    restrictedProjectReach: cmd.projectReach ?? cur.restrictedProjectReach,
  };
}

/**
 * `ceiling show` prints the owner ceiling, the sandbox allowlist and the revision; `ceiling set`
 * changes the named fields under the policy lock, the others as they are then (converting an
 * old-format file).
 * Narrowing applies directly; widening needs --yes or a confirmed terminal answer. Only the
 * machine's owner widens it: the deployment may only narrow.
 */
export async function ceilingCommand(
  cmd: Extract<Command, { command: "ceiling" }>,
  deps: CeilingDeps,
): Promise<number> {
  const { stateDir, out, err } = deps;
  let store: PolicyStore;
  try {
    store = new PolicyStore(stateDir);
  } catch (e) {
    err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  const cur = store.current();
  if (cmd.action === "show" && cmd.json === true) {
    out(
      JSON.stringify({
        outsideSandbox: cur.ownerCeiling.outsideSandbox,
        network: cur.ownerCeiling.network,
        allowedDomains: cur.allowedDomains,
        projectReach: cur.ownerCeiling.restrictedProjectReach,
        // the strict reader's digest of the policy generation; null while logged out
        revision: strictRevision(stateDir, deps.home),
      }),
    );
    return 0;
  }
  if (cmd.action === "show") {
    for (const line of describe(cur.ownerCeiling)) out(line);
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
          deviceId: cred.deviceId,
          dir: cred.dir,
          home: deps.home,
        });
        out(`Revision: ${strict.revision}`);
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
  if (widens(cur.ownerCeiling, target(cmd, cur.ownerCeiling))) {
    out(CEILING_WIDENING_TEXT);
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
  let written: OwnerCeilingPolicy;
  try {
    // decided again on the policy under the lock: a narrowing that landed since the read above
    // makes this a widening, which needs its own confirmation
    written = store.update((p) => {
      const next = target(cmd, p.ownerCeiling);
      if (!confirmed && widens(p.ownerCeiling, next)) throw new WideningNeedsConfirmation();
      return { ...p, ownerCeiling: next };
    }).ownerCeiling;
  } catch (e) {
    if (e instanceof WideningNeedsConfirmation) {
      out(CEILING_WIDENING_TEXT);
      err(`The owner ceiling changed meanwhile. ${CEILING_NEEDS_YES}`);
      return 2;
    }
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  noteCliPolicyChange(
    stateDir,
    `ceiling set outsideSandbox ${written.outsideSandbox ? "on" : "off"}, network ` +
      `${written.network}, projectReach ${written.restrictedProjectReach}`,
  );
  out("This machine's owner ceiling is now:");
  for (const line of describe(written)) out(line);
  if (written.network === "allowlist")
    out(
      "Sandboxed commands reach only the sandbox allowlist (capybara-device policy add " +
        "allowedDomains <host>).",
    );
  if (written.restrictedProjectReach === "os-user")
    out("Sandboxed work may reach selected projects outside the device's workspace.");
  return 0;
}
