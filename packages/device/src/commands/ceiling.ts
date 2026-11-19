import type { Command } from "../args.js";
import { noteCliPolicyChange } from "../command-log.js";
import { readStrictOwnerCeilingSync } from "../exec/operation-types.js";
import { PolicyStore } from "../policy-store.js";
import { type OwnerCeilingPolicy, policyPath, readCredential } from "../state.js";

/** Printed before a widening is applied (by --yes or a confirmed prompt). */
export const CEILING_WIDENING_TEXT =
  "Widening this machine's owner ceiling lets the deployment ask for more here. Full access lets " +
  "a conversation the owner switches to Full run commands as you, with your files, credentials " +
  "and network. The os-user project reach lets restricted operations and project browsing read " +
  "projects outside the device's workspace. Conversations need fresh Full consent either way.";

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

/** Thrown inside the locked update when the policy now on disk makes the target a widening. */
class WideningNeedsConfirmation extends Error {}

const describe = (c: OwnerCeilingPolicy): string[] => [
  `Full access: ${c.fullAccess ? "allowed" : "denied"}`,
  `Project reach: ${c.restrictedProjectReach}`,
];

/** True when `next` allows anything `cur` does not. */
export function widens(cur: OwnerCeilingPolicy, next: OwnerCeilingPolicy): boolean {
  return (
    (!cur.fullAccess && next.fullAccess) ||
    (cur.restrictedProjectReach === "workspace" && next.restrictedProjectReach === "os-user")
  );
}

/**
 * `ceiling show` prints the owner ceiling, the restricted network baseline and the revision;
 * `ceiling set` writes both fields at once under the policy lock (converting an old-format file).
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
  if (cmd.action === "show") {
    for (const line of describe(cur.ownerCeiling)) out(line);
    out(
      `Restricted network baseline: ${cur.allowedDomains.length > 0 ? cur.allowedDomains.join(", ") : "none"}`,
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
      "The platform and organization Full access settings and this machine's runtime support " +
        "apply separately; the deployment's device page shows the effective permissions.",
    );
    return 0;
  }
  const next: OwnerCeilingPolicy = {
    fullAccess: cmd.fullAccess,
    restrictedProjectReach: cmd.projectReach,
  };
  let confirmed = cmd.yes === true;
  if (widens(cur.ownerCeiling, next)) {
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
      if (!confirmed && widens(p.ownerCeiling, next)) throw new WideningNeedsConfirmation();
      return { ...p, ownerCeiling: { ...next } };
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
    `ceiling set fullAccess ${written.fullAccess ? "allow" : "deny"}, projectReach ` +
      written.restrictedProjectReach,
  );
  out("This machine's owner ceiling is now:");
  for (const line of describe(written)) out(line);
  if (written.restrictedProjectReach === "os-user")
    out("Restricted operations may reach selected projects outside the device's workspace.");
  return 0;
}
