import { homedir } from "node:os";
import { hasLoginService } from "../service/installed.js";
import { signalRunning } from "./signal.js";

/**
 * `stop`: SIGTERM to the running program. A machine that runs the program as a login service is
 * stopped through it instead: launchd's `KeepAlive` (and systemd's restart) would start a signalled
 * program straight back up, so `service stop` (which unloads the service) is the honest path.
 */
export function stop(
  stateDir: string,
  out: (line: string) => void,
  err: (line: string) => void,
  kill?: typeof process.kill,
  service?: { home: string; platform: NodeJS.Platform },
): number {
  const where = service ?? { home: homedir(), platform: process.platform };
  if (hasLoginService(where.home, where.platform)) {
    err(
      "capybara-device runs as a login service on this machine. Stop it with: capybara-device service stop",
    );
    return 1;
  }
  return signalRunning(stateDir, "SIGTERM", "Stopping capybara-device.", out, err, kill);
}
