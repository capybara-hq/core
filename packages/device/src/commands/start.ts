import { type Connection, connect } from "../client.js";
import { CommandLog } from "../command-log.js";
import type { Executor } from "../exec/types.js";
import { readRunningPid, removePid, writePid } from "../pid.js";
import { type Credential, type Policy, readCredential, readPolicy } from "../state.js";

export interface StartDeps {
  stateDir: string;
  /** Builds the executor for the credential's mode (the OS and Docker executors). */
  createExecutor?: (cred: Credential, policy: Policy) => Promise<Executor> | Executor;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The process whose signals stop and drain the program. */
  proc?: Pick<NodeJS.Process, "on" | "off" | "pid">;
  kill?: typeof process.kill;
  connect?: typeof connect;
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
    err("Not logged in. Run capybara-device login --url <url> first.");
    return 1;
  }
  if (deps.createExecutor === undefined) {
    err("capybara-device start: no execution backend is available in this build");
    return 1;
  }
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
    try {
      executor = await deps.createExecutor(cred, readPolicy(stateDir));
    } catch (e) {
      err(`Cannot start: ${(e as Error).message}`);
      return 1;
    }
    if (stopRequested) return 0;
    conn = (deps.connect ?? connect)(cred, executor, { log: new CommandLog(stateDir), err });
    if (drainRequested) conn.drain();
    out(`capybara-device: serving environment ${cred.environmentId} (${cred.mode} mode)`);
    return await conn.done;
  } finally {
    proc.off("SIGTERM", onStop);
    proc.off("SIGINT", onStop);
    proc.off("SIGUSR2", onDrain);
    removePid(stateDir, proc.pid);
  }
}
