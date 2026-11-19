import type { Command } from "../args.js";
import { noteCliPolicyChange } from "../command-log.js";
import { PolicyStore } from "../policy-store.js";
import { KEEP_AWAKE_MODES, type KeepAwakeMode, policyPath } from "../state.js";

export const KEEP_AWAKE_PROMPT = "Keep this computer awake more often? [y/N] ";
export const KEEP_AWAKE_NEEDS_YES =
  "Nothing changed. To keep this computer awake more often, add --yes (or answer y at the prompt).";
/** What keep-awake cannot prevent (spec §9.7), printed with the mode. */
export const KEEP_AWAKE_LIMITS =
  "Keep-awake cannot prevent sleep when the lid of a Mac on battery is closed without an " +
  "external display, when Sleep is chosen, at a critically low battery or in a thermal " +
  "emergency, nor (on Linux) the lid switch. A sleeping computer is offline for the deployment.";
const RAISE_TEXT =
  "While the device is connected or busy, this computer will not go to idle sleep; it uses more " +
  "power and a laptop in a bag can get warm.";

export interface KeepAwakeDeps {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

const rank = (m: KeepAwakeMode): number => KEEP_AWAKE_MODES.indexOf(m);

class RaiseNeedsConfirmation extends Error {}

/**
 * `keep-awake show` prints the mode; `keep-awake off|while-busy|connected` writes it under the
 * policy lock. Lowering applies directly; raising needs --yes or a confirmed terminal answer. A
 * running program applies the change without a restart.
 */
export async function keepAwakeCommand(
  cmd: Extract<Command, { command: "keep-awake" }>,
  deps: KeepAwakeDeps,
): Promise<number> {
  const { stateDir, out, err } = deps;
  let store: PolicyStore;
  try {
    store = new PolicyStore(stateDir);
  } catch (e) {
    err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  const cur = store.current().keepAwake;
  if (cmd.action === "show") {
    if (cmd.json === true) out(JSON.stringify({ keepAwake: cur }));
    else {
      out(`Keep-awake: ${cur}`);
      out(KEEP_AWAKE_LIMITS);
    }
    return 0;
  }
  const next = cmd.mode;
  let confirmed = cmd.yes === true;
  if (rank(next) > rank(cur)) {
    out(RAISE_TEXT);
    if (!confirmed) {
      if (deps.ask === undefined) {
        err(KEEP_AWAKE_NEEDS_YES);
        return 2;
      }
      const answer = (await deps.ask(KEEP_AWAKE_PROMPT)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        err("Nothing changed.");
        return 1;
      }
      confirmed = true;
    }
  }
  try {
    // decided again on the policy under the lock: a lowering that landed since the read above
    // makes this a raise, which needs its own confirmation
    store.update((p) => {
      if (!confirmed && rank(next) > rank(p.keepAwake)) throw new RaiseNeedsConfirmation();
      return { ...p, keepAwake: next };
    });
  } catch (e) {
    if (e instanceof RaiseNeedsConfirmation) {
      err(`The keep-awake mode changed meanwhile. ${KEEP_AWAKE_NEEDS_YES}`);
      return 2;
    }
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  noteCliPolicyChange(stateDir, `keep-awake set ${next}`);
  out(cmd.json === true ? JSON.stringify({ keepAwake: next }) : `Keep-awake is now: ${next}`);
  return 0;
}
