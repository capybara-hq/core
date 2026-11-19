import { homedir } from "node:os";
import type { Connection } from "../client.js";
import { type ProcessLookup, readRunningPid, removePid, writePid } from "../pid.js";
import { PolicyStore } from "../policy-store.js";
import { hasLoginService } from "../service/installed.js";
import { rotateServiceLog } from "../service/launchd.js";
import { startedByServiceManager } from "../service/manager.js";
import { connectStaged } from "../staged-connect.js";
import type { StagedDevice } from "../staged-device.js";
import { type Credential, convertPolicyFile, policyMode, readCredential } from "../state.js";
import { PROGRAM_VERSION } from "../version.js";

export interface StartDeps {
  stateDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Where the login service would be installed, and on which platform (default: this machine). */
  service?: { home: string; platform: NodeJS.Platform };
  /** The process whose signals stop and drain the program. */
  proc?: Pick<NodeJS.Process, "on" | "off" | "pid">;
  kill?: typeof process.kill;
  ps?: ProcessLookup;
  /** The environment (default: process.env): tells whether the service manager started this. */
  env?: Record<string, string | undefined>;
  /**
   * Builds the program's parts for the credential: the binder, one operation backend per bound
   * generation, the per-credential session states and the owner policy.
   */
  createStaged?: (cred: Credential, policy: PolicyStore) => Promise<StagedDevice> | StagedDevice;
  connectStaged?: typeof connectStaged;
}

/** Printed once when start converted an old-format policy.json to version 2. */
export function legacyPolicyNotice(mode: "auto" | "sandbox"): string {
  return (
    "policy.json now uses the version 2 owner ceiling; this machine runs in " +
    `${mode} mode; see \`capybara-device ceiling show\`.`
  );
}

/** `start`: connect and serve in the foreground until stopped, drained, revoked or replaced. */
export async function start(deps: StartDeps): Promise<number> {
  const { stateDir, out, err } = deps;
  const proc = deps.proc ?? process;
  let cred: Credential | undefined;
  try {
    cred = readCredential(stateDir);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  if (cred === undefined) {
    // A deliberate stop: exit 0, which the service manager does not restart (launchd
    // `KeepAlive { SuccessfulExit: false }`, systemd `Restart=on-failure`) until someone logs in
    // and starts it.
    err("Not logged in. Run capybara-device login --url <url> first.");
    return 0;
  }
  if (deps.createStaged === undefined) {
    err("capybara-device start: no execution backend is available in this build");
    return 1;
  }
  const where = deps.service ?? { home: homedir(), platform: process.platform };
  if (
    hasLoginService(where.home, where.platform) &&
    !startedByServiceManager(deps.env ?? process.env, proc.pid)
  ) {
    // Started in a terminal while a service is installed: say how to control the installed one.
    // The service manager runs exactly this command, so it must keep working, without the hint.
    out(
      "capybara-device runs as a login service on this machine. Restart it with: capybara-device service restart",
    );
  }
  rotateServiceLog(stateDir);
  const running = readRunningPid(stateDir, {
    ...(deps.kill && { kill: deps.kill }),
    ...(deps.ps && { ps: deps.ps }),
  });
  if (running !== undefined && running !== proc.pid) {
    err(`capybara-device is already running (pid ${running}). Stop it first: capybara-device stop`);
    return 1;
  }
  // Signals arriving while the program is still being prepared are applied once connected.
  let conn: Connection | undefined;
  let stopRequested = false;
  let drainRequested = false;
  const onStop = (): void => {
    stopRequested = true;
    conn?.stop();
  };
  const onDrain = (): void => {
    drainRequested = true;
    out("Draining: no new commands; stopping when the running ones finish.");
    conn?.drain();
  };
  proc.on("SIGTERM", onStop);
  proc.on("SIGINT", onStop);
  proc.on("SIGUSR2", onDrain);
  writePid(stateDir, proc.pid, PROGRAM_VERSION);
  try {
    return await serveStaged(deps, cred, {
      stopRequested: () => stopRequested,
      drainRequested: () => drainRequested,
      connected: (c) => {
        conn = c;
      },
    });
  } finally {
    proc.off("SIGTERM", onStop);
    proc.off("SIGINT", onStop);
    proc.off("SIGUSR2", onDrain);
    removePid(stateDir, proc.pid);
  }
}

/**
 * The start proper (device protocol 3): the policy store, the program's parts (binder,
 * per-generation backends, per-credential session state), recovery of a persisted binding, then
 * {@link connectStaged}.
 */
async function serveStaged(
  deps: StartDeps,
  cred: Credential,
  signals: {
    stopRequested: () => boolean;
    drainRequested: () => boolean;
    connected: (conn: Connection) => void;
  },
): Promise<number> {
  const { stateDir, out, err } = deps;
  let device: StagedDevice;
  try {
    const converted = convertPolicyFile(stateDir) === "converted";
    const policy = new PolicyStore(stateDir);
    if (converted) out(legacyPolicyNotice(policyMode(policy.current())));
    device = await (deps.createStaged as NonNullable<StartDeps["createStaged"]>)(cred, policy);
  } catch (e) {
    err(`Cannot start: ${(e as Error).message}`);
    return 1;
  }
  try {
    // a persisted binding of this credential comes back for same-generation journal recovery
    await device.binder.recover();
  } catch (e) {
    // the program stays unbound; a binding request reports the same problem to the deployment
    err(`The instance binding was not recovered: ${(e as Error).message}`);
  }
  if (signals.stopRequested()) {
    // stopped before it connected: release what construction acquired
    await device.dispose().catch((e: unknown) => err(`Cleanup failed: ${(e as Error).message}`));
    return 0;
  }
  const conn = (deps.connectStaged ?? connectStaged)(device, {
    err,
    // read before each reconnect only: a new login while running discards the old credential's
    // state (B-3)
    credential: () => {
      try {
        return readCredential(stateDir);
      } catch {
        return undefined; // unreadable now: keep serving the credential it started with
      }
    },
  });
  signals.connected(conn);
  if (signals.drainRequested()) conn.drain();
  out(`capybara-device: serving device ${cred.deviceId} (${cred.mode} mode)`);
  return await conn.done;
}
