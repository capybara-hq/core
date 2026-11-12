import { isAlive, readRunningPid } from "../pid.js";
import { signalRunning } from "./signal.js";

/** How often `drain --wait` checks whether the program has exited. */
export const DRAIN_POLL_MS = 500;
/** How long `drain --wait` waits by default (commands may run long). */
export const DRAIN_WAIT_DEFAULT_SECONDS = 600;

/** `drain`: SIGUSR2 to the running program: no new commands, stop when the running ones finish. */
export function drain(
  stateDir: string,
  out: (line: string) => void,
  err: (line: string) => void,
  kill?: typeof process.kill,
): number {
  return signalRunning(stateDir, "SIGUSR2", "Draining capybara-device.", out, err, kill);
}

/**
 * `drain --wait`: {@link drain}, then waits until the program has exited (its running commands
 * finished), at most `timeoutMs`. Exit code 1 when it still runs then.
 */
export async function drainAndWait(
  stateDir: string,
  out: (line: string) => void,
  err: (line: string) => void,
  o: {
    kill?: typeof process.kill;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const kill = o.kill ?? process.kill;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs ?? DRAIN_WAIT_DEFAULT_SECONDS * 1000;
  const pid = readRunningPid(stateDir, kill);
  const code = drain(stateDir, out, err, kill);
  if (code !== 0 || pid === undefined) return code;
  for (let waited = 0; isAlive(pid, kill); waited += DRAIN_POLL_MS) {
    if (waited >= timeoutMs) {
      err(
        `capybara-device (pid ${pid}) is still draining after ${Math.round(timeoutMs / 1000)} s: ` +
          "commands are still running. Wait longer with drain --wait, or stop it now with stop.",
      );
      return 1;
    }
    await sleep(Math.min(DRAIN_POLL_MS, timeoutMs - waited));
  }
  out("capybara-device has stopped.");
  return 0;
}
