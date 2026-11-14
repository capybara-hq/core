import { homedir } from "node:os";
import { type Connection, connect } from "../client.js";
import { CommandLog } from "../command-log.js";
import { sandboxUnavailableMessage } from "../exec/sandbox-messages.js";
import type { Executor } from "../exec/types.js";
import { type ProcessLookup, readRunningPid, removePid, writePid } from "../pid.js";
import { PolicyStore } from "../policy-store.js";
import { hasLoginService } from "../service/installed.js";
import { rotateServiceLog } from "../service/launchd.js";
import { startedByServiceManager } from "../service/manager.js";
import { type Credential, readCredential } from "../state.js";
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
}

/** Printed once when policy.json was written before auto mode (spec §4.4). */
export function legacyPolicyNotice(mode: "auto" | "sandbox"): string {
  return (
    "policy.json now uses `mode`; this machine runs in " +
    `${mode} mode; switch with \`capybara-device mode\`.`
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
  if (deps.createExecutor === undefined) {
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
    let executor: Executor;
    let policy: PolicyStore;
    try {
      // An invalid policy.json stops the start; later, a broken edit keeps the last good policy.
      policy = new PolicyStore(stateDir, { err });
      if (policy.legacy) out(legacyPolicyNotice(policy.current().mode));
      executor = await deps.createExecutor(cred, policy);
      // Without the OS sandbox the device keeps serving: auto mode works, and sandbox mode
      // refuses every command with this reason. A policy set to sandbox says so at start.
      const sandbox = executor as { available?: boolean; unavailableReason?: string };
      if (sandbox.available === false && policy.current().mode === "sandbox") {
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
