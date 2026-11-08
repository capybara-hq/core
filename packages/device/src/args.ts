import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

export type DeviceMode = "os" | "docker";

/** A parsed command line. */
export type Command =
  | { command: "login"; url: string; browser: boolean; dir?: string; mode: DeviceMode }
  | { command: "logout" }
  | { command: "status"; json: boolean }
  | { command: "start" }
  | { command: "stop" }
  | { command: "drain" }
  | { command: "policy"; action: "show" }
  | { command: "policy"; action: "set"; key: string; value: string }
  | { command: "service"; action: "install" | "uninstall" }
  | { command: "help" };

export const USAGE = `Usage:
  capybara-device login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]
                                  Connect this machine: approve the code in the browser
  capybara-device logout          Forget the credential on this machine
  capybara-device status [--json] Show whether this machine is logged in
  capybara-device start           Connect and serve the environment
  capybara-device stop            Stop the running program
  capybara-device drain           Finish running commands, accept no new ones, then stop
  capybara-device policy [show]   Show the local policy
  capybara-device policy set <key> <value>
  capybara-device service install|uninstall
                                  Run at login as a user service`;

/** Thrown for a bad command line; the message is shown with the usage. */
export class UsageError extends Error {}

function parse<const O extends ParseArgsOptionsConfig>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** Parses `argv` (without the node and script entries); throws {@link UsageError}. */
export function parseCommandLine(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { command: "help" };
  }
  const noArgs = (command: "logout" | "start" | "stop" | "drain"): Command => {
    const { positionals } = parse(rest, {});
    if (positionals.length > 0) throw new UsageError(`${command} takes no arguments`);
    return { command };
  };
  switch (name) {
    case "login": {
      const { values, positionals } = parse(rest, {
        url: { type: "string" },
        "no-browser": { type: "boolean" },
        dir: { type: "string" },
        mode: { type: "string" },
      });
      if (positionals.length > 0) throw new UsageError("login takes no positional arguments");
      if (values.url === undefined || values.url === "") throw new UsageError("login needs --url");
      const mode = values.mode ?? "os";
      if (mode !== "os" && mode !== "docker") throw new UsageError("--mode must be os or docker");
      return {
        command: "login",
        url: String(values.url),
        browser: values["no-browser"] !== true,
        ...(values.dir !== undefined && { dir: String(values.dir) }),
        mode,
      };
    }
    case "status": {
      const { values, positionals } = parse(rest, { json: { type: "boolean" } });
      if (positionals.length > 0) throw new UsageError("status takes no arguments");
      return { command: "status", json: values.json === true };
    }
    case "logout":
    case "start":
    case "stop":
    case "drain":
      return noArgs(name);
    case "policy": {
      const { positionals } = parse(rest, {});
      const [action, key, value, ...extra] = positionals;
      if (action === undefined || (action === "show" && key === undefined && extra.length === 0)) {
        return { command: "policy", action: "show" };
      }
      if (action === "set" && key !== undefined && value !== undefined && extra.length === 0) {
        return { command: "policy", action: "set", key, value };
      }
      throw new UsageError("usage: policy [show | set <key> <value>]");
    }
    case "service": {
      const { positionals } = parse(rest, {});
      const [action, ...extra] = positionals;
      if ((action === "install" || action === "uninstall") && extra.length === 0) {
        return { command: "service", action };
      }
      throw new UsageError("usage: service install|uninstall");
    }
    default:
      throw new UsageError(`unknown command ${name}`);
  }
}
