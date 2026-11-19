import { homedir } from "node:os";
import { parseCommandLine, USAGE, UsageError } from "./args.js";
import { ceilingCommand } from "./commands/ceiling.js";
import { drain, drainAndWait } from "./commands/drain.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { policyCommand } from "./commands/policy.js";
import { serviceCommand } from "./commands/service.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import type { ProcessLookup } from "./pid.js";
import type { PolicyStore } from "./policy-store.js";
import type { RunSystem } from "./service/manager.js";
import type { StagedDevice } from "./staged-device.js";
import { type Credential, stateDir } from "./state.js";

export interface CliEnv {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Builds the program's parts (the binder and the operation backends). */
  createStaged?: (cred: Credential, policy: PolicyStore) => Promise<StagedDevice> | StagedDevice;
  kill?: typeof process.kill;
  /** Runs a system command for `service` and `stop` and returns its output (default: execFileSync). */
  runSystem?: RunSystem;
  /** Looks a process up by pid, to check a pid file names this program (default: `ps`). */
  ps?: ProcessLookup;
  /** Standard input is a terminal (default: `process.stdin.isTTY`): a confirmation may be asked. */
  stdinIsTTY?: boolean;
  /** Whether the OS sandbox can run here, for `login` (default: the runtime's check). */
  sandboxAvailable?: () => { ok: true } | { ok: false; reason: string };
  /** Asks one question on the terminal and resolves the answer (default: node:readline). */
  ask?: (question: string) => Promise<string>;
  /** Test seam for `ceiling set`: runs between its read and its locked write. */
  beforeCeilingWrite?: () => void;
}

/** Asks one question on the process's terminal. */
async function askOnTerminal(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The program's parts (device protocol 3): the binder with one operation backend per bound
 * generation, built for this host (macOS, Linux) or the device's container (docker mode). Loaded
 * on demand: only start needs them.
 */
function defaultCreateStaged(stateDir: string, home: string) {
  return async (cred: Credential, store: PolicyStore): Promise<StagedDevice> => {
    const { createStagedDevice } = await import("./staged-device.js");
    if (cred.mode === "docker") {
      const { createDockerContainer } = await import("./exec/docker.js");
      const container = await createDockerContainer({
        dir: cred.dir,
        deviceId: cred.deviceId,
        policy: () => store.current(),
      });
      return createStagedDevice({ cred, stateDir, policy: store, home, container });
    }
    return createStagedDevice({ cred, stateDir, policy: store, home });
  };
}

/** Runs one command line and returns the exit code. */
export async function runCli(argv: string[], io: CliEnv = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const platform = io.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    err("capybara-device runs on macOS and Linux. On Windows use WSL or Docker.");
    return 1;
  }
  let cmd: ReturnType<typeof parseCommandLine>;
  try {
    cmd = parseCommandLine(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  const home = io.home ?? homedir();
  const dir = stateDir(io.env ?? process.env, home);
  switch (cmd.command) {
    case "help":
      out(USAGE);
      return 0;
    case "login":
      return login(cmd, {
        stateDir: dir,
        home,
        platform,
        out,
        err,
        ...(io.fetch && { fetch: io.fetch }),
        ...(io.sleep && { sleep: io.sleep }),
        ...(io.openBrowser && { openBrowser: io.openBrowser }),
        ...(io.sandboxAvailable && { sandboxAvailable: io.sandboxAvailable }),
      });
    case "logout":
      return logout(dir, {
        out,
        err,
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
      });
    case "status":
      return status(dir, cmd.json, out, err, {
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
      });
    case "start":
      return start({
        service: { home, platform },
        stateDir: dir,
        out,
        err,
        createStaged: io.createStaged ?? defaultCreateStaged(dir, home),
        ...(io.env && { env: io.env }),
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
      });
    case "stop":
      return stop(dir, out, err, {
        service: { home, platform },
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
        ...(io.runSystem && { run: io.runSystem }),
      });
    case "drain":
      if (cmd.wait !== true) {
        return drain(dir, out, err, {
          ...(io.kill && { kill: io.kill }),
          ...(io.ps && { ps: io.ps }),
        });
      }
      return drainAndWait(dir, out, err, {
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
        ...(io.sleep && { sleep: io.sleep }),
        ...(cmd.timeoutSeconds !== undefined && { timeoutMs: cmd.timeoutSeconds * 1000 }),
      });
    case "policy":
      return policyCommand(cmd, { stateDir: dir, out, err });
    case "ceiling":
      return ceilingCommand(cmd, {
        stateDir: dir,
        home,
        out,
        err,
        ...((io.stdinIsTTY ?? process.stdin.isTTY === true) && { ask: io.ask ?? askOnTerminal }),
        ...(io.beforeCeilingWrite && { beforeWrite: io.beforeCeilingWrite }),
      });
    case "service":
      return serviceCommand(cmd.action, {
        stateDir: dir,
        home,
        platform,
        env: io.env ?? process.env,
        out,
        err,
        ...(io.runSystem && { run: io.runSystem }),
        ...(io.sleep && { sleep: io.sleep }),
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
      });
  }
}
