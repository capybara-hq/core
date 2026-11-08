import { readRunningPid } from "../pid.js";

/** Sends `signal` to the running program; exit code 0 when it was signalled, 1 when none runs. */
export function signalRunning(
  stateDir: string,
  signal: NodeJS.Signals,
  message: string,
  out: (line: string) => void,
  err: (line: string) => void,
  kill: typeof process.kill = process.kill,
): number {
  const pid = readRunningPid(stateDir, kill);
  if (pid === undefined) {
    err("capybara-device is not running.");
    return 1;
  }
  try {
    kill(pid, signal);
  } catch (e) {
    err(`Could not signal pid ${pid}: ${(e as Error).message}`);
    return 1;
  }
  out(message);
  return 0;
}
