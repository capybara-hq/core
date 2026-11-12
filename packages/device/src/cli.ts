import { homedir } from "node:os";
import { parseCommandLine, USAGE, UsageError } from "./args.js";
import { drain } from "./commands/drain.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { confirmRisk, needsConfirmation, policyCommand, policyRisk } from "./commands/policy.js";
import { serviceCommand } from "./commands/service.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import type { Executor } from "./exec/types.js";
import type { PolicyStore } from "./policy-store.js";
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
  createExecutor?: (cred: Credential, policy: PolicyStore) => Promise<Executor> | Executor;
  kill?: typeof process.kill;
  /** Runs a system command for `service` (default: execFileSync). */
  runSystem?: (cmd: string, args: string[]) => void;
  /** Standard input is a terminal (default: `process.stdin.isTTY`): a confirmation may be asked. */
  stdinIsTTY?: boolean;
  /** Asks one question on the terminal and resolves the answer (default: node:readline). */
  ask?: (question: string) => Promise<string>;
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

/** Shown once when a Docker-mode device's policy says `isolation: none` (it is ignored there). */
export const DOCKER_ISOLATION_IGNORED =
  "policy.json says isolation none, which works in OS mode only: this device runs commands in " +
  "Docker mode, always in a container.";

/** Logged when commands start or stop running without a sandbox. */
export const UNSANDBOXED_ON = "Commands on this device now run without a sandbox (isolation none).";
export const UNSANDBOXED_OFF = "Commands on this device run in the sandbox again.";

/**
 * The executor for the credential's mode; the program's state directory is unreadable to
 * sandboxed commands. OS mode serves a {@link SwitchingExecutor}: the OS sandbox, or no sandbox
 * when the owner set `isolation none` locally and the command's tier is `open` (spec §5.4).
 */
function defaultCreateExecutor(stateDir: string, home: string, err: (line: string) => void) {
  return async (cred: Credential, store: PolicyStore): Promise<Executor> => {
    const policy = () => store.current();
    if (cred.mode === "docker") {
      if (policy().isolation === "none") err(DOCKER_ISOLATION_IGNORED);
      const { createDockerExecutor } = await import("./exec/docker.js");
      return createDockerExecutor({
        dir: cred.dir,
        deviceId: cred.deviceId,
        policy,
      });
    }
    // Loaded on demand: the sandbox runtime is only needed by start.
    const [{ createOsExecutor }, { HostExecutor }, { SwitchingExecutor }] = await Promise.all([
      import("./exec/os.js"),
      import("./exec/host.js"),
      import("./exec/switch.js"),
    ]);
    const sandboxed = await createOsExecutor({
      dir: cred.dir,
      policy,
      home,
      denyRead: [stateDir],
    });
    return new SwitchingExecutor(sandboxed, new HostExecutor({ dir: cred.dir }), policy, (i) =>
      err(i === "none" ? UNSANDBOXED_ON : UNSANDBOXED_OFF),
    );
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
      });
    case "logout":
      return logout(dir, { out, err, ...(io.kill && { kill: io.kill }) });
    case "status":
      return status(dir, cmd.json, out, err);
    case "start":
      return start({
        stateDir: dir,
        out,
        err,
        createExecutor: io.createExecutor ?? defaultCreateExecutor(dir, home, err),
        ...(io.kill && { kill: io.kill }),
      });
    case "stop":
      return stop(dir, out, err, io.kill);
    case "drain":
      return drain(dir, out, err, io.kill);
    case "policy": {
      // `set tier open` / `set isolation none` without --yes: ask on a terminal (after printing
      // the risk text); elsewhere policyCommand refuses them.
      if (needsConfirmation(cmd) && (io.stdinIsTTY ?? process.stdin.isTTY === true)) {
        if (!(await confirmRisk(cmd, { out, ask: io.ask ?? askOnTerminal }))) {
          err(policyRisk(cmd)?.needsYes ?? "Nothing changed.");
          return 1;
        }
        return policyCommand(cmd, { stateDir: dir, out, err, confirmed: true });
      }
      return policyCommand(cmd, { stateDir: dir, out, err });
    }
    case "service":
      return serviceCommand(cmd.action, {
        stateDir: dir,
        home,
        platform,
        env: io.env ?? process.env,
        out,
        err,
        ...(io.runSystem && { run: io.runSystem }),
      });
  }
}
