import { homedir } from "node:os";
import { parseCommandLine, USAGE, UsageError } from "./args.js";
import { ceilingCommand } from "./commands/ceiling.js";
import { drain, drainAndWait } from "./commands/drain.js";
import { keepAwakeCommand } from "./commands/keep-awake.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { policyCommand } from "./commands/policy.js";
import { serviceCommand } from "./commands/service.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import {
  type ConnectionInfo,
  ConnectionSelectError,
  connectionDir,
  DEVICE_ID_PATTERN,
  machineDirOfConnection,
  resolveConnection,
  unreadableConnections,
} from "./connections.js";
import type { HostProbes } from "./docker-host.js";
import { stamped } from "./log-timestamp.js";
import type { ProcessLookup } from "./pid.js";
import type { PolicyStore } from "./policy-store.js";
import { hasLoginService } from "./service/installed.js";
import { type RunSystem, startedByOldLoginService } from "./service/manager.js";
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
  /** The host facts of the docker-mode check (default: this machine). */
  hostProbes?: HostProbes;
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
 * The program's parts (device protocol 4): the binder with one operation backend per bound
 * generation, built for this host (macOS, Linux) or the device's container (docker mode). Loaded
 * on demand: only start needs them.
 */
export function defaultCreateStaged(stateDir: string, home: string, log?: (line: string) => void) {
  // the program state root is the machine directory holding every connection (this one included)
  const stateRoot = machineDirOfConnection(stateDir);
  return async (cred: Credential, store: PolicyStore): Promise<StagedDevice> => {
    const { createStagedDevice } = await import("./staged-device.js");
    if (cred.mode === "docker") {
      const { createDockerContainer } = await import("./exec/docker.js");
      const container = await createDockerContainer({
        dir: cred.dir,
        deviceId: cred.deviceId,
        policy: () => store.current(),
      });
      return createStagedDevice({
        cred,
        stateDir,
        stateRoot,
        policy: store,
        home,
        container,
        ...(log && { log }),
      });
    }
    return createStagedDevice({ cred, stateDir, stateRoot, policy: store, home });
  };
}

/** The connection `logout` removes: a readable one, or an unreadable one named by its device id. */
function logoutTarget(
  selector: string | undefined,
  machineDir: string,
): { stateDir: string; deviceId: string } {
  try {
    const c = resolveConnection(selector, machineDir);
    return { stateDir: c.stateDir, deviceId: c.deviceId };
  } catch (e) {
    if (
      selector !== undefined &&
      DEVICE_ID_PATTERN.test(selector) &&
      unreadableConnections(machineDir).some((u) => u.deviceId === selector)
    ) {
      return { stateDir: connectionDir(machineDir, selector), deviceId: selector };
    }
    throw e;
  }
}

/**
 * The connection `service uninstall|status` act on: a readable one, or an exact device id whose
 * service is installed although its connection no longer resolves (its credential is gone), so
 * that service can always be removed.
 */
function serviceTarget(
  selector: string | undefined,
  action: string,
  machineDir: string,
  home: string,
  platform: NodeJS.Platform,
): { stateDir: string; deviceId: string } {
  try {
    return resolveConnection(selector, machineDir);
  } catch (e) {
    if (
      (action === "uninstall" || action === "status") &&
      selector !== undefined &&
      DEVICE_ID_PATTERN.test(selector) &&
      hasLoginService(home, platform, selector)
    ) {
      return { stateDir: connectionDir(machineDir, selector), deviceId: selector };
    }
    throw e;
  }
}

/**
 * Whether `start` failing to resolve means there is no connection to serve (it exits 0), not a
 * connection that is broken or an ambiguous choice (those exit 1 with their message). Throws when
 * the connections cannot be scanned.
 */
function isNothingToStart(e: unknown, selector: string | undefined, machineDir: string): boolean {
  if (!(e instanceof ConnectionSelectError) || e.code === "ambiguous") return false;
  const broken = unreadableConnections(machineDir);
  return selector === undefined
    ? broken.length === 0
    : !broken.some((u) => u.deviceId === selector);
}

/** What the old login service's plain `start` prints before it exits 0 and stays stopped. */
export const OLD_LOGIN_SERVICE_MESSAGE =
  "Started by the login service of the old layout (launchd top.capybara.device, systemd " +
  "capybara-device.service); not starting. Remove it with capybara-device service uninstall " +
  "from the old version (or delete its file by hand), then run capybara-device service install " +
  "-c <deviceId>.";

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
  const machineDir = stateDir(io.env ?? process.env, home);
  /** The one connection the command runs against; prints why and gives none when it is not one. */
  const connected = (): ConnectionInfo | undefined => {
    if (cmd.command === "help" || cmd.command === "login") return undefined;
    try {
      return resolveConnection(cmd.connection, machineDir);
    } catch (e) {
      err((e as Error).message);
      return undefined;
    }
  };
  switch (cmd.command) {
    case "help":
      out(USAGE);
      return 0;
    case "login":
      return login(cmd, {
        machineDir,
        home,
        platform,
        out,
        err,
        ...(io.fetch && { fetch: io.fetch }),
        ...(io.sleep && { sleep: io.sleep }),
        ...(io.openBrowser && { openBrowser: io.openBrowser }),
        ...(io.sandboxAvailable && { sandboxAvailable: io.sandboxAvailable }),
        ...(io.hostProbes && { hostProbes: io.hostProbes }),
      });
    case "logout": {
      let conn: { stateDir: string; deviceId: string };
      try {
        conn = logoutTarget(cmd.connection, machineDir);
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
      return logout(conn, {
        out,
        err,
        home,
        platform,
        ...(io.env && { env: io.env }),
        ...(io.runSystem && { run: io.runSystem }),
        ...(io.sleep && { sleep: io.sleep }),
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
      });
    }
    case "status":
      return status(machineDir, cmd.connection, cmd.json, out, err, {
        home,
        platform,
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
      });
    case "start": {
      // Every per-connection service passes --connection: a plain start by a service manager is
      // the old login service. Exit 0 keeps it stopped (launchd SuccessfulExit false, systemd
      // Restart=on-failure); it would otherwise serve or loop on "already running".
      if (cmd.connection === undefined && startedByOldLoginService(io.env ?? process.env)) {
        stamped(err)(OLD_LOGIN_SERVICE_MESSAGE);
        return 0;
      }
      let conn: ConnectionInfo;
      try {
        conn = resolveConnection(cmd.connection, machineDir);
      } catch (e) {
        let nothing: boolean;
        try {
          nothing = isNothingToStart(e, cmd.connection, machineDir);
        } catch (scan) {
          err((scan as Error).message);
          return 1;
        }
        if (!nothing) {
          err((e as Error).message);
          return 1;
        }
        // A logged-out connection's service stays stopped: exit 0 is not restarted by the
        // service manager (launchd SuccessfulExit false, systemd Restart=on-failure).
        stamped(err)(
          cmd.connection === undefined
            ? "Not logged in. Run capybara-device login --url <url> first."
            : `No connection ${cmd.connection} on this machine; nothing to start.`,
        );
        return 0;
      }
      const dir = conn.stateDir;
      // The service log has no other clock: every line `start` writes carries a timestamp.
      return start({
        service: { home, platform },
        stateDir: dir,
        out: stamped(out),
        err: stamped(err),
        createStaged: io.createStaged ?? defaultCreateStaged(dir, home, stamped(out)),
        ...(io.env && { env: io.env }),
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
        ...(io.hostProbes && { hostProbes: io.hostProbes }),
      });
    }
    case "stop": {
      const dir = connected()?.stateDir;
      if (dir === undefined) return 1;
      return stop(dir, out, err, {
        service: { home, platform },
        ...(io.kill && { kill: io.kill }),
        ...(io.ps && { ps: io.ps }),
        ...(io.runSystem && { run: io.runSystem }),
      });
    }
    case "drain": {
      const dir = connected()?.stateDir;
      if (dir === undefined) return 1;
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
    }
    case "policy": {
      const dir = connected()?.stateDir;
      if (dir === undefined) return 1;
      return policyCommand(cmd, {
        stateDir: dir,
        stateRoot: machineDirOfConnection(dir),
        home,
        out,
        err,
      });
    }
    case "ceiling": {
      const dir = connected()?.stateDir;
      if (dir === undefined) return 1;
      return ceilingCommand(cmd, {
        stateDir: dir,
        stateRoot: machineDirOfConnection(dir),
        home,
        out,
        err,
        ...((io.stdinIsTTY ?? process.stdin.isTTY === true) && { ask: io.ask ?? askOnTerminal }),
        ...(io.beforeCeilingWrite && { beforeWrite: io.beforeCeilingWrite }),
      });
    }
    case "keep-awake": {
      const dir = connected()?.stateDir;
      if (dir === undefined) return 1;
      return keepAwakeCommand(cmd, {
        stateDir: dir,
        out,
        err,
        ...((io.stdinIsTTY ?? process.stdin.isTTY === true) && { ask: io.ask ?? askOnTerminal }),
      });
    }
    case "service": {
      let conn: { stateDir: string; deviceId: string };
      try {
        conn = serviceTarget(cmd.connection, cmd.action, machineDir, home, platform);
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
      return serviceCommand(
        cmd.action,
        {
          stateDir: conn.stateDir,
          deviceId: conn.deviceId,
          home,
          platform,
          env: io.env ?? process.env,
          out,
          err,
          ...(io.runSystem && { run: io.runSystem }),
          ...(io.sleep && { sleep: io.sleep }),
          ...(io.kill && { kill: io.kill }),
          ...(io.ps && { ps: io.ps }),
        },
        { json: cmd.json === true },
      );
    }
  }
}
