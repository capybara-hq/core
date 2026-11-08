import { homedir } from "node:os";
import { parseCommandLine, USAGE, UsageError } from "./args.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { status } from "./commands/status.js";
import { stateDir } from "./state.js";

export interface CliEnv {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
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
    default:
      // start, stop, drain, policy and service arrive with the later tasks of the plan.
      err(`capybara-device ${cmd.command}: not implemented yet`);
      return 2;
  }
}
