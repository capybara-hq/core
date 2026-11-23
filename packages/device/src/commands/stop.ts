import { homedir } from "node:os";
import { DEVICE_ID_PATTERN } from "../connections.js";
import { type ProcessChecks, readRunning } from "../pid.js";
import { hasLoginService } from "../service/installed.js";
import { defaultRunSystem, managerState, type RunSystem } from "../service/manager.js";
import { readCredential } from "../state.js";
import { signalRunning } from "./signal.js";

export interface StopOptions extends ProcessChecks {
  /** Where the login service would be installed, and on which platform (default: this machine). */
  service?: { home: string; platform: NodeJS.Platform; uid?: number };
  /** Asks the service manager (default: execFileSync). */
  run?: RunSystem;
}

/** The device of the connection's credential; none when it is missing or unreadable. */
function credentialDeviceId(stateDir: string): string | undefined {
  try {
    const id = readCredential(stateDir)?.deviceId;
    return id !== undefined && DEVICE_ID_PATTERN.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `stop`: SIGTERM to the running program. When the service manager runs that program (launchd has
 * the service loaded, systemd has the unit active, and its pid is the running one), `stop` refuses
 * and points at `service stop`, which unloads the service: a signalled service program would be
 * started again by the restart policy, or would leave a service that looks loaded but stays down.
 * A program started in a terminal is signalled as before, with or without a service installed.
 */
export function stop(
  stateDir: string,
  out: (line: string) => void,
  err: (line: string) => void,
  opts: StopOptions = {},
): number {
  const where = opts.service ?? { home: homedir(), platform: process.platform };
  const checks: ProcessChecks = {
    ...(opts.kill && { kill: opts.kill }),
    ...(opts.ps && { ps: opts.ps }),
  };
  const deviceId = credentialDeviceId(stateDir);
  if (deviceId !== undefined && hasLoginService(where.home, where.platform, deviceId)) {
    const state = managerState({ ...where, deviceId }, opts.run ?? defaultRunSystem);
    const program = readRunning(stateDir, checks);
    if (state.loaded && program !== undefined && state.pid === program.pid) {
      err(
        "capybara-device runs as a login service on this machine. Stop it with: " +
          `capybara-device service stop -c ${deviceId}`,
      );
      return 1;
    }
  }
  return signalRunning(stateDir, "SIGTERM", "Stopping capybara-device.", out, err, checks);
}
