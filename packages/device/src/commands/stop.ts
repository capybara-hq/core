import { signalRunning } from "./signal.js";

/** `stop`: SIGTERM to the running program. */
export function stop(
  stateDir: string,
  out: (line: string) => void,
  err: (line: string) => void,
  kill?: typeof process.kill,
): number {
  return signalRunning(stateDir, "SIGTERM", "Stopping capybara-device.", out, err, kill);
}
