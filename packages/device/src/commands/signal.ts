import { type ProcessChecks, readRunningPid } from "../pid.js";

/**
 * Sends `signal` to the running program; exit code 0 when it was signalled, 1 when none runs. A
 * pid the file names but that is not this program any more is never signalled.
 */
export function signalRunning(
  stateDir: string,
  signal: NodeJS.Signals,
  message: string,
  out: (line: string) => void,
  err: (line: string) => void,
  checks: ProcessChecks = {},
): number {
  const pid = readRunningPid(stateDir, checks);
  if (pid === undefined) {
    err("capybara-device is not running.");
    return 1;
  }
  try {
    (checks.kill ?? process.kill)(pid, signal);
  } catch (e) {
    err(`Could not signal pid ${pid}: ${(e as Error).message}`);
    return 1;
  }
  out(message);
  return 0;
}
