import { isAlive, type ProcessLookup, readRunningPid } from "../pid.js";
import { removeCredential } from "../state.js";

export interface LogoutDeps {
  out: (line: string) => void;
  err?: (line: string) => void;
  kill?: typeof process.kill;
  ps?: ProcessLookup;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a running program to exit (default 5 s). */
  waitMs?: number;
}

const POLL_MS = 100;

/**
 * `logout`: stops a running program, then forgets the credential on this machine. Revoking it on
 * the platform is done there.
 */
export async function logout(stateDir: string, deps: LogoutDeps): Promise<number> {
  const { out } = deps;
  const err = deps.err ?? out;
  const kill = deps.kill ?? process.kill;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pid = readRunningPid(stateDir, { kill, ...(deps.ps && { ps: deps.ps }) });
  if (pid !== undefined && pid !== process.pid) {
    out(`Stopping the running capybara-device (pid ${pid}).`);
    try {
      kill(pid, "SIGTERM");
    } catch {
      // It exited in between.
    }
    const waitMs = deps.waitMs ?? 5000;
    let waited = 0;
    while (isAlive(pid, kill) && waited < waitMs) {
      await sleep(POLL_MS);
      waited += POLL_MS;
    }
    if (isAlive(pid, kill)) {
      err(`capybara-device (pid ${pid}) is still running; it keeps its connection until it exits.`);
    }
  }
  out(
    removeCredential(stateDir)
      ? "Logged out. The working directory was left in place."
      : "Not logged in.",
  );
  return 0;
}
