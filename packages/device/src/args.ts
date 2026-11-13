import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { SandboxMode } from "./state.js";

export type DeviceMode = "os" | "docker";

/** A parsed command line. */
export type Command =
  | { command: "login"; url: string; browser: boolean; dir?: string; mode: DeviceMode }
  | { command: "logout" }
  | { command: "status"; json: boolean }
  | { command: "start" }
  | { command: "stop" }
  | {
      command: "drain";
      /** `--wait`: wait until the program has exited. */
      wait?: true;
      /** `--timeout <seconds>` with `--wait` (default 600). */
      timeoutSeconds?: number;
    }
  | { command: "policy"; action: "show" }
  | {
      command: "policy";
      action: "set" | "add" | "remove";
      key: string;
      value: string;
    }
  | {
      command: "mode";
      /** Absent: print the current mode. */
      mode?: SandboxMode;
      /** `--yes`: confirms `mode auto` without asking. */
      yes?: true;
    }
  | { command: "service"; action: "install" | "uninstall" }
  | { command: "help" };

export const USAGE = `Usage:
  capybara-device login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]
                                  Connect this machine: approve the code in the browser
  capybara-device logout          Forget the credential on this machine
  capybara-device status [--json] Show whether this machine is logged in
  capybara-device start           Connect and serve the device
  capybara-device stop            Stop the running program
  capybara-device drain [--wait] [--timeout <seconds>]
                                  Finish running commands, accept no new ones, then stop;
                                  --wait returns once it has stopped (default limit 600 s)
  capybara-device mode [auto|sandbox] [--yes]
                                  Show or choose how commands run: auto (as you on this
                                  machine, every command reviewed) or sandbox (applies at
                                  the next command; auto needs --yes or a y at the prompt)
  capybara-device policy [show]   Show the local policy
  capybara-device policy set <key> <value>
                                  Replace one field (cpu, memoryMb, allowCredentials)
  capybara-device policy add|remove allowedDomains <host>
                                  Allow or stop allowing a domain in sandbox mode
  capybara-device policy add|remove allowCredentials <name>
                                  Allow or stop allowing a credential in sandbox mode
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
  const noArgs = (command: "logout" | "start" | "stop"): Command => {
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
      return noArgs(name);
    case "drain": {
      const { values, positionals } = parse(rest, {
        wait: { type: "boolean" },
        timeout: { type: "string" },
      });
      if (positionals.length > 0) throw new UsageError("drain takes no positional arguments");
      if (values.timeout !== undefined && values.wait !== true) {
        throw new UsageError("--timeout needs --wait");
      }
      if (values.wait !== true) return { command: "drain" };
      if (values.timeout === undefined) return { command: "drain", wait: true };
      const seconds = Number(values.timeout);
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new UsageError("--timeout must be a whole number of seconds, at least 1");
      }
      return { command: "drain", wait: true, timeoutSeconds: seconds };
    }
    case "policy": {
      const { positionals } = parse(rest, {});
      const [action, key, value, ...extra] = positionals;
      if (action === undefined) return { command: "policy", action: "show" };
      if (action === "show" && key === undefined && extra.length === 0) {
        return { command: "policy", action: "show" };
      }
      if (
        (action === "set" || action === "add" || action === "remove") &&
        key !== undefined &&
        value !== undefined &&
        extra.length === 0
      ) {
        return { command: "policy", action, key, value };
      }
      throw new UsageError("usage: policy [show | set <key> <value> | add|remove <key> <value>]");
    }
    case "mode": {
      const { values, positionals } = parse(rest, { yes: { type: "boolean", short: "y" } });
      const [which, ...extra] = positionals;
      if (extra.length > 0) {
        throw new UsageError("usage: mode [auto|sandbox] [--yes]");
      }
      if (which !== undefined && which !== "auto" && which !== "sandbox") {
        throw new UsageError("mode must be auto or sandbox");
      }
      const yes = values.yes === true;
      if (yes && which === undefined) {
        throw new UsageError("--yes needs a mode: mode auto|sandbox");
      }
      return {
        command: "mode",
        ...(which !== undefined && { mode: which }),
        ...(yes && which !== undefined && { yes: true as const }),
      };
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
