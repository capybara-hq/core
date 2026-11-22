import { DEVICE_ID_PATTERN } from "../connections.js";
import { isAlive, type ProcessLookup, readRunningPid } from "../pid.js";
import { hasLoginService } from "../service/installed.js";
import type { RunSystem } from "../service/manager.js";
import { removeCredential } from "../state.js";
import { serviceCommand } from "./service.js";

export interface LogoutDeps {
  out: (line: string) => void;
  err?: (line: string) => void;
  kill?: typeof process.kill;
  ps?: ProcessLookup;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a running program to exit (default 5 s). */
  waitMs?: number;
  /** Where the connection's login service would be installed, and how to ask the manager. */
  home: string;
  platform: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  run?: RunSystem;
}

const POLL_MS = 100;

/**
 * `logout` of one connection: removes its login service (which stops it) or stops a running
 * program, then forgets the credential on this machine. Its policy.json, logs and working
 * directory stay, and so do the other connections. Revoking it on the platform is done there.
 */
export async function logout(
  conn: { stateDir: string; deviceId: string },
  deps: LogoutDeps,
): Promise<number> {
  const { stateDir, deviceId } = conn;
  const { out } = deps;
  const err = deps.err ?? out;
  const kill = deps.kill ?? process.kill;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  if (DEVICE_ID_PATTERN.test(deviceId) && hasLoginService(deps.home, deps.platform, deviceId)) {
    // The service manager would restart a signalled program; uninstalling stops it for good.
    const code = await serviceCommand(
      "uninstall",
      {
        stateDir,
        deviceId,
        home: deps.home,
        platform: deps.platform,
        env: deps.env ?? process.env,
        out,
        err,
        ...(deps.run && { run: deps.run }),
        sleep,
        kill,
        ...(deps.ps && { ps: deps.ps }),
      },
      { json: false },
    );
    if (code !== 0) {
      err(`The login service could not be removed; the credential of ${deviceId} was kept.`);
      return code;
    }
  }
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
