import { signalRunning } from "./signal.js";

/** `drain`: SIGUSR2 to the running program: no new commands, stop when the running ones finish. */
export function drain(
  stateDir: string,
  out: (line: string) => void,
  err: (line: string) => void,
  kill?: typeof process.kill,
): number {
  return signalRunning(stateDir, "SIGUSR2", "Draining capybara-device.", out, err, kill);
}
