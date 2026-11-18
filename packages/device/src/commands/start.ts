import { homedir } from "node:os";
import { DEVICE_PROTOCOL_VERSION, STAGED_DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk";
import { type Connection, connect } from "../client.js";
import { CommandLog } from "../command-log.js";
import { sandboxUnavailableMessage } from "../exec/sandbox-messages.js";
import type { Executor } from "../exec/types.js";
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
  /**
   * Builds the executor for the credential's mode (the OS and Docker executors). The store
   * follows policy.json, so executors read the policy at each command.
   */
  createExecutor?: (cred: Credential, policy: PolicyStore) => Promise<Executor> | Executor;
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
  connect?: typeof connect;
  /**
   * Builds the staged (protocol 3) program's parts for the credential: the binder, one operation
   * backend per bound generation, the per-credential session states and the owner policy. Used
   * only when the protocol is the staged one.
   */
  createStaged?: (cred: Credential, policy: PolicyStore) => Promise<StagedDevice> | StagedDevice;
  connectStaged?: typeof connectStaged;
  /**
   * Test seam: the device protocol this program speaks (default: the SDK's
   * `DEVICE_PROTOCOL_VERSION`). Production never sets it: the staged path is selected only by
   * that constant.
   */
  protocol?: number;
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
  // the staged (protocol 3) path is selected only by the protocol constant
  const staged = (deps.protocol ?? DEVICE_PROTOCOL_VERSION) === STAGED_DEVICE_PROTOCOL_VERSION;
  if (staged ? deps.createStaged === undefined : deps.createExecutor === undefined) {
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
  // Signals arriving while the executor is still being prepared are applied once connected.
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
    if (staged)
      return await serveStaged(deps, cred, {
        stopRequested: () => stopRequested,
        drainRequested: () => drainRequested,
        connected: (c) => {
          conn = c;
        },
      });
    let executor: Executor;
    let policy: PolicyStore;
    try {
      // An invalid policy.json stops the start; later, a broken edit keeps the last good policy.
      // The one-time explicit conversion to the version 2 format (locked, atomic, exact).
      const converted = convertPolicyFile(stateDir) === "converted";
      policy = new PolicyStore(stateDir, { err });
      if (converted) out(legacyPolicyNotice(policyMode(policy.current())));
      executor = await (deps.createExecutor as NonNullable<StartDeps["createExecutor"]>)(
        cred,
        policy,
      );
      // Without the OS sandbox the device keeps serving: auto mode works, and sandbox mode
      // refuses every command with this reason. A policy set to sandbox says so at start.
      const sandbox = executor as { available?: boolean; unavailableReason?: string };
      if (sandbox.available === false && policyMode(policy.current()) === "sandbox") {
        err(sandboxUnavailableMessage(sandbox.unavailableReason ?? ""));
      }
    } catch (e) {
      err(`Cannot start: ${(e as Error).message}`);
      return 1;
    }
    if (stopRequested) return 0;
    // One store: the executor's commands, the hello summary and the policy op see the same policy.
    conn = (deps.connect ?? connect)(cred, executor, {
      log: new CommandLog(stateDir),
      err,
      policy,
    });
    if (drainRequested) conn.drain();
    out(`capybara-device: serving device ${cred.deviceId} (${cred.mode} mode)`);
    return await conn.done;
  } finally {
    proc.off("SIGTERM", onStop);
    proc.off("SIGINT", onStop);
    proc.off("SIGUSR2", onDrain);
    removePid(stateDir, proc.pid);
  }
}

/**
 * The staged (protocol 3) start (permission activation W3-M): the policy store, the staged parts
 * (binder, per-generation backends, per-credential session state), recovery of a persisted
 * binding, then {@link connectStaged}. Dormant until the protocol constant selects it.
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
    const policy = new PolicyStore(stateDir, { err });
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
    // stopped before it connected: release what construction acquired (the Docker executor)
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
