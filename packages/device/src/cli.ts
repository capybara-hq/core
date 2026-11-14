import { homedir } from "node:os";
import { parseCommandLine, USAGE, UsageError } from "./args.js";
import { drain, drainAndWait } from "./commands/drain.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { modeCommand } from "./commands/mode.js";
import { policyCommand } from "./commands/policy.js";
import { serviceCommand } from "./commands/service.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import type { Executor } from "./exec/types.js";
import type { ProcessLookup } from "./pid.js";
import type { PolicyStore } from "./policy-store.js";
import type { RunSystem } from "./service/manager.js";
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
  /** Runs a system command for `service` and `stop` and returns its output (default: execFileSync). */
  runSystem?: RunSystem;
  /** Looks a process up by pid, to check a pid file names this program (default: `ps`). */
  ps?: ProcessLookup;
  /** Standard input is a terminal (default: `process.stdin.isTTY`): a confirmation may be asked. */
  stdinIsTTY?: boolean;
  /** Whether the OS sandbox can run here, for `login` and `mode` (default: the runtime's check). */
  sandboxAvailable?: () => { ok: true } | { ok: false; reason: string };
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

/**
 * Logged when the local policy switches between auto and sandbox. It names the local choice, not
 * the effective mode: the organization's ceiling still cuts it (a device whose org forbids auto
 * runs in the sandbox even with this policy).
 */
export const AUTO_MODE_ON =
  "This machine's local policy is auto mode; the deployment's ceiling applies.";
export const AUTO_MODE_OFF =
  "This machine's local policy is sandbox mode; commands still running in auto mode were stopped.";

/**
 * The executor for the credential's mode; the program's state directory is unreadable to
 * sandboxed commands. OS mode serves a {@link SwitchingExecutor}: the host (auto mode) or the OS
 * sandbox (sandbox mode), chosen per command from the policy and the kernel's ceiling (spec §4.1).
 */
function defaultCreateExecutor(stateDir: string, home: string, err: (line: string) => void) {
  return async (cred: Credential, store: PolicyStore): Promise<Executor> => {
    const policy = () => store.current();
    if (cred.mode === "docker") {
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
    return new SwitchingExecutor(sandboxed, new HostExecutor({ dir: cred.dir }), policy, (mode) =>
      err(mode === "auto" ? AUTO_MODE_ON : AUTO_MODE_OFF),
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
      return status(dir, cmd.json, out, err);
    case "start":
      return start({
        service: { home, platform },
        stateDir: dir,
        out,
        err,
        createExecutor: io.createExecutor ?? defaultCreateExecutor(dir, home, err),
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
    case "mode":
      return modeCommand(cmd, {
        stateDir: dir,
        out,
        err,
        ...(io.sandboxAvailable && { sandboxAvailable: io.sandboxAvailable }),
        ...((io.stdinIsTTY ?? process.stdin.isTTY === true) && { ask: io.ask ?? askOnTerminal }),
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
