import { type Connection, connect } from "../client.js";
import { CommandLog } from "../command-log.js";
import type { Executor } from "../exec/types.js";
import { readRunningPid, removePid, writePid } from "../pid.js";
import { PolicyStore } from "../policy-store.js";
import { rotateServiceLog } from "../service/launchd.js";
import { type Credential, readCredential } from "../state.js";

export interface StartDeps {
  stateDir: string;
  /**
   * Builds the executor for the credential's mode (the OS and Docker executors). The store
   * follows policy.json, so executors read the policy at each command.
   */
  createExecutor?: (cred: Credential, policy: PolicyStore) => Promise<Executor> | Executor;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The process whose signals stop and drain the program. */
  proc?: Pick<NodeJS.Process, "on" | "off" | "pid">;
  kill?: typeof process.kill;
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
    // Terminal: exit 0 so a service manager does not restart it until someone logs in.
    err("Not logged in. Run capybara-device login --url <url> first.");
    return 0;
  }
  if (deps.createExecutor === undefined) {
    err("capybara-device start: no execution backend is available in this build");
    return 1;
  }
  rotateServiceLog(stateDir);
  const running = readRunningPid(stateDir, deps.kill);
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
  writePid(stateDir, proc.pid);
  try {
    let executor: Executor;
    let policy: PolicyStore;
    try {
      // An invalid policy.json stops the start; later, a broken edit keeps the last good policy.
      policy = new PolicyStore(stateDir, { err });
      if (policy.legacy) out(legacyPolicyNotice(policy.current().mode));
      executor = await deps.createExecutor(cred, policy);
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
