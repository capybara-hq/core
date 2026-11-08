import { homedir } from "node:os";
import { parseCommandLine, USAGE, UsageError } from "./args.js";
import { drain } from "./commands/drain.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { policyCommand } from "./commands/policy.js";
import { serviceCommand } from "./commands/service.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import type { Executor } from "./exec/types.js";
import { type Credential, type Policy, stateDir } from "./state.js";

export interface CliEnv {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
  createExecutor?: (cred: Credential, policy: Policy) => Promise<Executor> | Executor;
  kill?: typeof process.kill;
  /** Runs a system command for `service` (default: execFileSync). */
  runSystem?: (cmd: string, args: string[]) => void;
}

/** The executor for the credential's mode; the program's state directory is unreadable to commands. */
function defaultCreateExecutor(stateDir: string, home: string) {
  return async (cred: Credential, policy: Policy): Promise<Executor> => {
    if (cred.mode === "docker") {
      const { createDockerExecutor } = await import("./exec/docker.js");
      return createDockerExecutor({
        dir: cred.dir,
        environmentId: cred.environmentId,
        policy,
      });
    }
    // Loaded on demand: the sandbox runtime is only needed by start.
    const { createOsExecutor } = await import("./exec/os.js");
    return createOsExecutor({ dir: cred.dir, policy, home, denyRead: [stateDir] });
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
      return logout(dir, out);
    case "status":
      return status(dir, cmd.json, out, err);
    case "start":
      return start({
        stateDir: dir,
        out,
        err,
        createExecutor: io.createExecutor ?? defaultCreateExecutor(dir, home),
        ...(io.kill && { kill: io.kill }),
      });
    case "stop":
      return stop(dir, out, err, io.kill);
    case "drain":
      return drain(dir, out, err, io.kill);
    case "policy":
      return policyCommand(cmd, { stateDir: dir, out, err });
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
