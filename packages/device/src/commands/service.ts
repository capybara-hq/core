import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProcessChecks, type RunningProgram, readRunning } from "../pid.js";
import { hasLoginService } from "../service/installed.js";
import { plistContent, plistPath, type ServiceSpec } from "../service/launchd.js";
import {
  defaultRunSystem,
  launchdTarget,
  type ManagerState,
  managerState,
  packageVersionAt,
  type RunSystem,
  type ServiceWhere,
  serviceBinPath,
} from "../service/manager.js";
import { SYSTEMD_UNIT, unitContent, unitPath } from "../service/systemd.js";

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "restart" | "status";

export interface ServiceDeps {
  stateDir: string;
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Runs a system command and returns its output; throws when it fails (default: execFileSync,
   * whose error carries the exit `status` and `stderr`).
   */
  run?: RunSystem;
  /** Waits between service manager checks (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** How the pid file's program is checked (default: `kill(pid, 0)` and `ps`). */
  kill?: typeof process.kill;
  ps?: ProcessChecks["ps"];
  uid?: number;
  nodePath?: string;
  binPath?: string;
}

/** The bin script next to this package's `dist` (or `src`) directory. */
function defaultBinPath(): string {
  return fileURLToPath(new URL("../../bin/capybara-device.mjs", import.meta.url));
}

/** What the service needs from the installing shell: PATH (docker lives there) and the state dir. */
export function serviceEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const path = env.PATH;
  out.PATH = path !== undefined && path !== "" ? path : "/usr/local/bin:/usr/bin:/bin";
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") out.XDG_CONFIG_HOME = xdg;
  return out;
}

/** How often launchctl is asked whether the old service is gone. */
export const SERVICE_POLL_MS = 200;
/** How long install / uninstall wait for `launchctl bootout` to finish (it is asynchronous). */
export const SERVICE_GONE_TIMEOUT_MS = 10_000;
/** How long `service start|restart` wait for the program to be running. */
export const SERVICE_UP_TIMEOUT_MS = 10_000;
/** The waits before each retry of a `launchctl bootstrap` that failed with error 5. */
export const BOOTSTRAP_BACKOFF_MS = [500, 1000, 2000] as const;

/**
 * `service install|uninstall|status`: runs `capybara-device start` at login (launchd) or boot
 * (systemd user), removes it, or reports whether it is loaded and running.
 */
export async function serviceCommand(action: ServiceAction, deps: ServiceDeps): Promise<number> {
  const run = deps.run ?? defaultRunSystem;
  const spec: ServiceSpec = {
    nodePath: deps.nodePath ?? process.execPath,
    binPath: deps.binPath ?? defaultBinPath(),
    stateDir: deps.stateDir,
    env: serviceEnv(deps.env),
  };
  try {
    if (deps.platform === "darwin") return await launchd(action, spec, deps, run);
    if (deps.platform === "linux") return await systemd(action, spec, deps, run);
  } catch (e) {
    deps.err(
      `capybara-device service ${action} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  deps.err("capybara-device service needs macOS (launchd) or Linux (systemd).");
  return 1;
}

/** The text launchctl printed for a failed call (its stderr, else the error message). */
function failureText(e: unknown): string {
  const stderr = (e as { stderr?: unknown }).stderr;
  const text =
    stderr instanceof Uint8Array || typeof stderr === "string" ? String(stderr).trim() : "";
  return text !== "" ? text : e instanceof Error ? e.message : String(e);
}

/**
 * `launchctl bootstrap` failed with error 5 (Input/output error): typically the previous instance
 * of the service is still being booted out.
 */
function isBootstrapIoError(e: unknown): boolean {
  return (e as { status?: unknown }).status === 5 || /Bootstrap failed: 5:/.test(failureText(e));
}

/** The pid file's program, checked to be this program (never trusted on the file alone). */
function running(deps: ServiceDeps): RunningProgram | undefined {
  return readRunning(deps.stateDir, {
    ...(deps.kill && { kill: deps.kill }),
    ...(deps.ps && { ps: deps.ps }),
  });
}

function where(deps: ServiceDeps): ServiceWhere {
  return {
    home: deps.home,
    platform: deps.platform,
    ...(deps.uid !== undefined && { uid: deps.uid }),
  };
}

const NOT_INSTALLED =
  "capybara-device service is not installed. Install it: capybara-device service install";

/**
 * One status report, in four shapes: not installed; installed but not loaded; loaded but the
 * program is not running (it exited: the reason is in service.log); running, with its pid and
 * version, plus a restart line when the package the service file runs is a different version (a
 * stale daemon after an upgrade). Exit code 0 only when running.
 */
function reportStatus(deps: ServiceDeps, run: RunSystem): number {
  const at = where(deps);
  if (!hasLoginService(at.home, at.platform)) {
    deps.out(NOT_INSTALLED);
    return 1;
  }
  const state = managerState(at, run);
  if (!state.loaded) {
    deps.out(
      "capybara-device service is installed but not loaded. Start it: capybara-device service start",
    );
    return 1;
  }
  if (state.pid === undefined) {
    deps.out(
      "capybara-device service is loaded, but the program is not running: it exited. The reason " +
        `is at the end of ${join(deps.stateDir, "service.log")}; once it is fixed: ` +
        "capybara-device service restart",
    );
    return 1;
  }
  const program = running(deps);
  const version = program?.pid === state.pid ? program.version : undefined;
  deps.out(
    `capybara-device service is loaded; running (pid ${state.pid}, ${version ?? "version unknown"}).`,
  );
  const bin = serviceBinPath(at);
  const installed = bin === undefined ? undefined : packageVersionAt(bin);
  if (installed !== undefined && version !== installed) {
    deps.out(`installed ${installed} — restart it: capybara-device service restart`);
  }
  return 0;
}

/**
 * Refuses to start the service while a program started outside it runs (`capybara-device start`
 * in a terminal): two programs would fight over the one connection of this device.
 */
function foregroundRunning(deps: ServiceDeps, state: ManagerState): boolean {
  const program = running(deps);
  if (program === undefined || program.pid === state.pid) return false;
  deps.err(
    `capybara-device is already running outside the service (pid ${program.pid}). Stop it first: capybara-device stop`,
  );
  return true;
}

/** Waits until the service manager runs the program (a pid other than `previous`). */
async function cameUp(
  deps: ServiceDeps,
  run: RunSystem,
  sleep: (ms: number) => Promise<void>,
  previous: number | undefined,
): Promise<boolean> {
  for (let waited = 0; ; waited += SERVICE_POLL_MS) {
    const pid = managerState(where(deps), run).pid;
    if (pid !== undefined && pid !== previous) return true;
    if (waited >= SERVICE_UP_TIMEOUT_MS) return false;
    await sleep(SERVICE_POLL_MS);
  }
}

/** The failure of a start or restart whose program is not running afterwards. */
function didNotComeBack(deps: ServiceDeps, action: "start" | "restart"): number {
  deps.err(
    `capybara-device service ${action} failed: the program is not running. The reason is at the ` +
      `end of ${join(deps.stateDir, "service.log")}.`,
  );
  return 1;
}

async function launchd(
  action: ServiceAction,
  spec: ServiceSpec,
  deps: ServiceDeps,
  run: RunSystem,
): Promise<number> {
  const file = plistPath(deps.home);
  const { domain, service } = launchdTarget(deps.uid);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tryRun = (args: string[]): void => {
    try {
      run("launchctl", args);
    } catch {
      // Not loaded yet / already gone.
    }
  };
  /** Whether launchd still knows the service (`launchctl print` fails once it is gone). */
  const loaded = (): boolean => managerState(where(deps), run).loaded;
  /** Boots the service out and waits until launchd has let it go (bootout returns before that). */
  const bootout = async (): Promise<void> => {
    tryRun(["bootout", service]);
    for (let waited = 0; loaded(); waited += SERVICE_POLL_MS) {
      // Gave up: bootstrap's retries cover what is left.
      if (waited >= SERVICE_GONE_TIMEOUT_MS) return;
      await sleep(SERVICE_POLL_MS);
    }
  };
  /** Boots the plist in, retrying launchd's transient "previous instance still going" error. */
  const bootstrap = async (): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        run("launchctl", ["bootstrap", domain, file]);
        return true;
      } catch (e) {
        if (!isBootstrapIoError(e)) throw e;
        const backoff = BOOTSTRAP_BACKOFF_MS[attempt];
        if (backoff === undefined) {
          deps.err(
            `launchctl bootstrap failed ${attempt + 1} times (${failureText(e)}). ` +
              `The previous capybara-device service may still be stopping: wait a few seconds and try again. ` +
              `launchctl print ${service} shows what launchd knows of it.`,
          );
          return false;
        }
        await sleep(backoff);
        await bootout();
      }
    }
  };
  const installed = (): boolean => hasLoginService(deps.home, "darwin");
  if (action === "status") return reportStatus(deps, run);
  if (action === "start" || action === "restart") {
    if (!installed()) {
      deps.err(NOT_INSTALLED);
      return 1;
    }
    const state = managerState(where(deps), run);
    if (action === "start" && state.pid !== undefined) {
      deps.out("The capybara-device login service is already running.");
      return 0;
    }
    if (foregroundRunning(deps, state)) return 1;
    if (state.loaded) {
      // Loaded: run the program again from the plist's bin (a newer package takes effect); a
      // loaded service whose program exited is started without a kill.
      run(
        "launchctl",
        state.pid === undefined ? ["kickstart", service] : ["kickstart", "-k", service],
      );
    } else if (!(await bootstrap())) {
      return 1;
    }
    if (!(await cameUp(deps, run, sleep, state.pid))) return didNotComeBack(deps, action);
    deps.out(
      action === "restart"
        ? "Restarted the capybara-device login service."
        : "Started the capybara-device login service.",
    );
    return 0;
  }
  if (action === "stop") {
    if (!installed()) {
      deps.err(NOT_INSTALLED);
      return 1;
    }
    if (!loaded()) {
      deps.out("The capybara-device login service is not running.");
      return 0;
    }
    // Unload, never a signal: KeepAlive would start a program that exits non-zero straight back.
    await bootout();
    if (loaded()) {
      deps.err(
        `capybara-device service stop failed: launchd still has the service loaded. Check with: launchctl print ${service}`,
      );
      return 1;
    }
    deps.out(
      "Stopped the capybara-device login service; running commands ended. It starts again at the next login or with: capybara-device service start",
    );
    return 0;
  }
  if (action === "install") {
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(spec.stateDir, { recursive: true });
    if (existsSync(file) || loaded()) await bootout();
    writeFileSync(file, plistContent(spec));
    if (!(await bootstrap())) return 1;
    deps.out(`Installed ${file}; capybara-device now starts at login.`);
    return 0;
  }
  await bootout();
  rmSync(file, { force: true });
  deps.out("Removed the capybara-device login service.");
  return 0;
}

async function systemd(
  action: ServiceAction,
  spec: ServiceSpec,
  deps: ServiceDeps,
  run: RunSystem,
): Promise<number> {
  const file = unitPath(deps.home);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const active = (): boolean => managerState(where(deps), run).loaded;
  const installed = (): boolean => hasLoginService(deps.home, "linux");
  if (action === "status") return reportStatus(deps, run);
  if (action === "start" || action === "stop" || action === "restart") {
    if (!installed()) {
      deps.err(NOT_INSTALLED);
      return 1;
    }
    const state = managerState(where(deps), run);
    if (action === "start" && state.loaded) {
      deps.out("The capybara-device login service is already running.");
      return 0;
    }
    if (action === "stop" && !state.loaded) {
      deps.out("The capybara-device login service is not running.");
      return 0;
    }
    if (action !== "stop" && !state.loaded && foregroundRunning(deps, state)) return 1;
    run("systemctl", ["--user", action, SYSTEMD_UNIT]);
    if (action === "stop") {
      if (active()) {
        deps.err(
          `capybara-device service stop failed: the unit is still active. Check with: systemctl --user status ${SYSTEMD_UNIT}`,
        );
        return 1;
      }
      deps.out(
        "Stopped the capybara-device login service; running commands ended. It starts again at the next login or with: capybara-device service start",
      );
      return 0;
    }
    if (!(await cameUp(deps, run, sleep, state.pid))) return didNotComeBack(deps, action);
    deps.out(
      action === "start"
        ? "Started the capybara-device login service."
        : "Restarted the capybara-device login service.",
    );
    return 0;
  }
  if (action === "install") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, unitContent(spec));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
    // restart, not start: a unit already running (an earlier install) picks up the new file.
    // systemctl waits for the stop and start jobs, so nothing is left in flight.
    run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    deps.out(
      `Installed ${file}; capybara-device now starts at login. A user unit runs only while you have a session unless you run: loginctl enable-linger $USER`,
    );
    return 0;
  }
  try {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  } catch {
    // Not installed.
  }
  rmSync(file, { force: true });
  try {
    run("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // No user manager: nothing is loaded.
  }
  deps.out("Removed the capybara-device user service.");
  return 0;
}
