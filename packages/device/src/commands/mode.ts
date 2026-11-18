import type { Command } from "../args.js";
import { sandboxUnavailableSwitchRefusal } from "../exec/sandbox-messages.js";
import { PolicyStore } from "../policy-store.js";
import {
  ownerCeilingOfMode,
  policyMode,
  policyPath,
  readCredential,
  type SandboxMode,
} from "../state.js";

/**
 * Shown once before auto mode is turned on, and once at login in an organization that allows it
 * (spec §8): the trust model is command review, not the OS sandbox.
 */
export const AUTO_MODE_RISK_TEXT =
  "In auto mode, agent commands run on this computer as you: they can read and write all your " +
  "files, use your credentials (SSH keys, cloud accounts, keychain), Docker and any network, and " +
  "the deployment reviews every command before it runs. Prompt injection can make an agent try " +
  "to delete files or send your credentials away; the review blocks or asks about the dangerous " +
  "ones. Such commands can also read this program's own credential: if you suspect misuse, run " +
  "capybara-device logout and log in again.";

/** The refusal of `capybara-device mode auto` without `--yes` or a `y` at the prompt. */
export const MODE_AUTO_NEEDS_YES =
  "Nothing changed. To run commands in auto mode, run: capybara-device mode auto --yes";

/** Printed before the question `capybara-device mode auto` asks on a terminal. */
export const MODE_AUTO_PROMPT = "Run agent commands on this computer as you, in auto mode? [y/N] ";

/** The OS sandbox check `login` and `mode` use (default: the runtime's, loaded on demand). */
export type SandboxCheck = () => { ok: true } | { ok: false; reason: string };

export async function checkSandbox(
  check: SandboxCheck | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (check !== undefined) return check();
  const os = await import("../exec/os.js");
  return os.sandboxAvailability();
}

export interface ModeDeps {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Asks the question on a terminal (only when standard input is one). Without it and without
   * `--yes`, `mode auto` changes nothing.
   */
  ask?: (question: string) => Promise<string>;
  /**
   * Whether the OS sandbox can run here (default: the runtime's check). `mode sandbox` is refused
   * when it cannot; injectable for tests.
   */
  sandboxAvailable?: SandboxCheck;
}

/** Whether this machine is logged in in Docker mode (false when unknown). */
function dockerRunMode(stateDir: string): boolean {
  try {
    return readCredential(stateDir)?.mode === "docker";
  } catch {
    return false;
  }
}

/** `mode` prints the current mode; `mode auto|sandbox` sets it (auto asks first). */
export async function modeCommand(
  cmd: Extract<Command, { command: "mode" }>,
  deps: ModeDeps,
): Promise<number> {
  const { stateDir, out, err } = deps;
  let store: PolicyStore;
  try {
    store = new PolicyStore(stateDir);
  } catch (e) {
    err(`Cannot read ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  const mode: SandboxMode | undefined = cmd.mode;
  if (mode === undefined) {
    const now = policyMode(store.current());
    out(`Mode: ${now}.`);
    out(
      now === "auto"
        ? "Commands run as you on this machine; the deployment reviews every command."
        : "Commands run in the OS sandbox; only the workspace, skills and temporary files are " +
            "writable and the network reaches the allowed hosts.",
    );
    return 0;
  }
  if (mode === "auto") {
    // The risk text is printed once, whether --yes was given or the question is asked.
    out(AUTO_MODE_RISK_TEXT);
    if (cmd.yes !== true) {
      if (deps.ask === undefined) {
        err(MODE_AUTO_NEEDS_YES);
        return 2;
      }
      const answer = (await deps.ask(MODE_AUTO_PROMPT)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        err("Nothing changed.");
        return 1;
      }
    }
  }
  let next: SandboxMode;
  if (mode === "sandbox" && !dockerRunMode(stateDir)) {
    // Sandbox mode cannot run a command without the OS sandbox; refuse the switch on such a
    // machine and leave the policy as it is (auto mode keeps working).
    const available = await checkSandbox(deps.sandboxAvailable);
    if (!available.ok) {
      err(sandboxUnavailableSwitchRefusal(available.reason));
      return 1;
    }
  }
  try {
    next = policyMode(store.update((p) => ({ ...p, ownerCeiling: ownerCeilingOfMode(mode) })));
  } catch (e) {
    err(`Cannot change ${policyPath(stateDir)}: ${(e as Error).message}`);
    return 1;
  }
  out(
    next === "auto"
      ? "This machine's local policy is now auto mode (from the next command); the deployment's " +
          "ceiling still applies."
      : "This machine's local policy is now sandbox mode (from the next command).",
  );
  // the mode sets both owner ceiling fields at once (M2): say so, reach included
  out(
    next === "auto"
      ? "Owner ceiling: Full access allowed, project reach: os-user (see capybara-device ceiling)."
      : "Owner ceiling: Full access denied, project reach: workspace (see capybara-device ceiling).",
  );
  return 0;
}
