import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { DeviceNetworkMode } from "@capybara-hq/plugin-sdk";
import { isKeepAwakeMode, type KeepAwakeMode, type RestrictedProjectReach } from "./state.js";

export type DeviceMode = "os" | "docker";

/** A parsed command line. */
export type Command =
  | {
      command: "login";
      url: string;
      browser: boolean;
      dir?: string;
      mode: DeviceMode;
      /** `--json`: one JSON event per line on stdout (implies `--no-browser`). */
      json?: true;
    }
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
  | { command: "ceiling"; action: "show"; json?: true }
  | {
      command: "ceiling";
      action: "set";
      /** `--outside-sandbox on|off`; absent keeps the current value. */
      outsideSandbox?: boolean;
      /** `--network open|allowlist`; absent keeps the current value. */
      network?: DeviceNetworkMode;
      /** `--project-reach workspace|os-user`; absent keeps the current value. */
      projectReach?: RestrictedProjectReach;
      /** `--yes`: confirms a widening without asking. */
      yes?: true;
    }
  | { command: "keep-awake"; action: "show"; json?: true }
  | {
      command: "keep-awake";
      action: "set";
      mode: KeepAwakeMode;
      /** `--yes`: confirms keeping the computer awake more often without asking. */
      yes?: true;
      json?: true;
    }
  | {
      command: "service";
      action: "install" | "uninstall" | "start" | "stop" | "restart" | "status";
      /** `service status --json`. */
      json?: true;
    }
  | { command: "help" };

export const USAGE = `Usage:
  capybara-device login --url <url> [--no-browser] [--dir <path>] [--mode os|docker] [--json]
                                  Connect this machine: approve the code in the browser;
                                  --json prints one JSON event per line (no browser)
  capybara-device logout          Forget the credential on this machine
  capybara-device status [--json] Show whether this machine is logged in
  capybara-device start           Connect and serve the device
  capybara-device stop            Stop the running program
  capybara-device drain [--wait] [--timeout <seconds>]
                                  Finish running commands, accept no new ones, then stop;
                                  --wait returns once it has stopped (default limit 600 s)
  capybara-device ceiling show [--json]
                                  Show this machine's owner ceiling (outside the sandbox, network,
                                  project reach)
  capybara-device ceiling set [--outside-sandbox on|off] [--network open|allowlist]
                              [--project-reach workspace|os-user] [--yes]
                                  Change the owner ceiling (at least one field; the others stay);
                                  widening needs --yes or a y at the prompt
  capybara-device keep-awake [show | off | while-busy | connected] [--yes] [--json]
                                  Show or set when this computer is kept awake; raising it
                                  needs --yes or a y at the prompt
  capybara-device policy [show]   Show the local policy
  capybara-device policy set <key> <value>
                                  Replace one field (cpu, memoryMb, allowCredentials)
  capybara-device policy add|remove allowedDomains <host>
                                  Allow or stop allowing a domain on the sandbox allowlist
  capybara-device policy add|remove allowCredentials <name>
                                  Allow or stop allowing a credential for restricted work
  capybara-device service install|uninstall
                                  Run at login as a user service, or remove it
  capybara-device service start|stop|restart
                                  Start, stop or restart the login service
  capybara-device service status [--json]
                                  Report whether the login service is loaded, what is running,
                                  and whether it is older than the installed program`;

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
        json: { type: "boolean" },
      });
      if (positionals.length > 0) throw new UsageError("login takes no positional arguments");
      if (values.url === undefined || values.url === "") throw new UsageError("login needs --url");
      const mode = values.mode ?? "os";
      if (mode !== "os" && mode !== "docker") throw new UsageError("--mode must be os or docker");
      return {
        command: "login",
        url: String(values.url),
        browser: values["no-browser"] !== true && values.json !== true,
        ...(values.dir !== undefined && { dir: String(values.dir) }),
        mode,
        ...(values.json === true && { json: true as const }),
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
    case "ceiling": {
      const { values, positionals } = parse(rest, {
        "outside-sandbox": { type: "string" },
        network: { type: "string" },
        "project-reach": { type: "string" },
        "full-access": { type: "string" },
        yes: { type: "boolean", short: "y" },
        json: { type: "boolean" },
      });
      const [action, ...extra] = positionals;
      const usage =
        "usage: ceiling show | ceiling set [--outside-sandbox on|off] [--network open|allowlist] " +
        "[--project-reach workspace|os-user] [--yes]";
      if (values["full-access"] !== undefined)
        throw new UsageError(
          `--full-access is gone: Full access always runs in the sandbox now; use --outside-sandbox on|off. ${usage}`,
        );
      if (extra.length > 0) throw new UsageError(usage);
      const outside = values["outside-sandbox"];
      const network = values.network;
      const reach = values["project-reach"];
      if (action === "show" || action === undefined) {
        if (outside !== undefined || network !== undefined || reach !== undefined)
          throw new UsageError(usage);
        return {
          command: "ceiling",
          action: "show",
          ...(values.json === true && { json: true as const }),
        };
      }
      if (action !== "set") throw new UsageError(usage);
      if (values.json === true) throw new UsageError(usage);
      if (outside === undefined && network === undefined && reach === undefined)
        throw new UsageError(usage);
      if (outside !== undefined && outside !== "on" && outside !== "off")
        throw new UsageError(usage);
      if (network !== undefined && network !== "open" && network !== "allowlist")
        throw new UsageError(usage);
      if (reach !== undefined && reach !== "workspace" && reach !== "os-user")
        throw new UsageError(usage);
      return {
        command: "ceiling",
        action: "set",
        ...(outside !== undefined && { outsideSandbox: outside === "on" }),
        ...(network !== undefined && { network }),
        ...(reach !== undefined && { projectReach: reach }),
        ...(values.yes === true && { yes: true as const }),
      };
    }
    case "keep-awake": {
      const { values, positionals } = parse(rest, {
        yes: { type: "boolean", short: "y" },
        json: { type: "boolean" },
      });
      const usage = "usage: keep-awake [show | off | while-busy | connected] [--yes] [--json]";
      const [action, ...extra] = positionals;
      if (extra.length > 0) throw new UsageError(usage);
      const json = values.json === true && { json: true as const };
      if (action === undefined || action === "show") {
        if (values.yes === true) throw new UsageError(usage);
        return { command: "keep-awake", action: "show", ...json };
      }
      if (!isKeepAwakeMode(action)) throw new UsageError(usage);
      return {
        command: "keep-awake",
        action: "set",
        mode: action,
        ...(values.yes === true && { yes: true as const }),
        ...json,
      };
    }
    case "service": {
      const { values, positionals } = parse(rest, { json: { type: "boolean" } });
      const [action, ...extra] = positionals;
      if (values.json === true && action !== "status") {
        throw new UsageError("--json is only for service status");
      }
      if (
        (action === "install" ||
          action === "uninstall" ||
          action === "start" ||
          action === "stop" ||
          action === "restart" ||
          action === "status") &&
        extra.length === 0
      ) {
        return {
          command: "service",
          action,
          ...(values.json === true && { json: true as const }),
        };
      }
      throw new UsageError("usage: service install|uninstall|start|stop|restart|status");
    }
    default:
      throw new UsageError(`unknown command ${name}`);
  }
}
