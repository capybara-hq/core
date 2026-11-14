import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunning } from "../pid.js";
import { LAUNCHD_LABEL, plistContent, plistPath, type ServiceSpec } from "../service/launchd.js";
import { SYSTEMD_UNIT, unitContent, unitPath } from "../service/systemd.js";
import { PROGRAM_VERSION } from "../version.js";

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "restart" | "status";

export interface ServiceDeps {
  stateDir: string;
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * Runs a system command; throws when it fails (default: execFileSync, whose error carries the
   * exit `status` and `stderr`).
   */
  run?: (cmd: string, args: string[]) => void;
  /** Waits between launchctl checks (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  uid?: number;
  nodePath?: string;
  binPath?: string;
}

function defaultRun(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "pipe" });
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
/** The waits before each retry of a `launchctl bootstrap` that failed with error 5. */
export const BOOTSTRAP_BACKOFF_MS = [500, 1000, 2000] as const;

/**
 * `service install|uninstall|status`: runs `capybara-device start` at login (launchd) or boot
 * (systemd user), removes it, or reports whether it is loaded and running.
 */
export async function serviceCommand(action: ServiceAction, deps: ServiceDeps): Promise<number> {
  const run = deps.run ?? defaultRun;
  const spec: ServiceSpec = {
    nodePath: deps.nodePath ?? process.execPath,
    binPath: deps.binPath ?? defaultBinPath(),
    stateDir: deps.stateDir,
    env: serviceEnv(deps.env),
  };
  try {
    if (deps.platform === "darwin") return await launchd(action, spec, deps, run);
    if (deps.platform === "linux") return systemd(action, spec, deps, run);
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

/**
 * One status report: installed? running (and at which version)? When the running program is older
 * than the installed package, a stale daemon after an upgrade — a restart makes it current.
 */
function reportStatus(
  deps: ServiceDeps,
  state: { installed: boolean; loaded: boolean },
  installedVersion: string,
): number {
  if (!state.installed) {
    deps.out(
      "capybara-device service is not installed. Install it: capybara-device service install",
    );
    return 1;
  }
  const running = readRunning(deps.stateDir);
  if (running === undefined || !state.loaded) {
    deps.out(
      "capybara-device service is installed, but nothing is running. Start it: capybara-device service start",
    );
    return 1;
  }
  deps.out(
    `capybara-device service is loaded; running (pid ${running.pid}, ${running.version ?? "version unknown"}).`,
  );
  if (running.version !== installedVersion) {
    deps.out(`installed ${installedVersion} — restart it: capybara-device service restart`);
  }
  return 0;
}

async function launchd(
  action: ServiceAction,
  spec: ServiceSpec,
  deps: ServiceDeps,
  run: (cmd: string, args: string[]) => void,
): Promise<number> {
  const file = plistPath(deps.home);
  const domain = `gui/${deps.uid ?? process.getuid?.() ?? 501}`;
  const service = `${domain}/${LAUNCHD_LABEL}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tryRun = (args: string[]): void => {
    try {
      run("launchctl", args);
    } catch {
      // Not loaded yet / already gone.
    }
  };
  /** Whether launchd still knows the service (`launchctl print` fails once it is gone). */
  const loaded = (): boolean => {
    try {
      run("launchctl", ["print", service]);
      return true;
    } catch {
      return false;
    }
  };
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
  const installed = (): boolean => existsSync(file);
  if (action === "status") {
    return reportStatus(deps, { installed: installed(), loaded: loaded() }, PROGRAM_VERSION);
  }
  if (action === "start" || action === "restart") {
    if (!installed()) {
      deps.err(
        "capybara-device service is not installed. Install it: capybara-device service install",
      );
      return 1;
    }
    if (action === "start" && loaded()) {
      deps.out("The capybara-device login service is already running.");
      return 0;
    }
    if (action === "restart" && loaded()) {
      // Reloads the program from the plist's bin, so a newer package takes effect.
      tryRun(["kickstart", "-k", service]);
      deps.out("Restarted the capybara-device login service.");
      return 0;
    }
    if (!(await bootstrap())) return 1;
    deps.out(
      action === "restart"
        ? "Restarted the capybara-device login service."
        : "Started the capybara-device login service.",
    );
    return 0;
  }
  if (action === "stop") {
    if (!installed()) {
      deps.err(
        "capybara-device service is not installed. Install it: capybara-device service install",
      );
      return 1;
    }
    if (!loaded()) {
      deps.out("The capybara-device login service is not running.");
      return 0;
    }
    // Unload, never a signal: KeepAlive would start a signalled program straight back up.
    await bootout();
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

function systemd(
  action: ServiceAction,
  spec: ServiceSpec,
  deps: ServiceDeps,
  run: (cmd: string, args: string[]) => void,
): number {
  const file = unitPath(deps.home);
  const active = (): boolean => {
    try {
      run("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]);
      return true;
    } catch {
      return false;
    }
  };
  const installed = (): boolean => existsSync(file);
  if (action === "status") {
    return reportStatus(deps, { installed: installed(), loaded: active() }, PROGRAM_VERSION);
  }
  if (action === "start" || action === "stop" || action === "restart") {
    if (!installed()) {
      deps.err(
        "capybara-device service is not installed. Install it: capybara-device service install",
      );
      return 1;
    }
    if (action === "start" && active()) {
      deps.out("The capybara-device login service is already running.");
      return 0;
    }
    if (action === "stop" && !active()) {
      deps.out("The capybara-device login service is not running.");
      return 0;
    }
    run("systemctl", ["--user", action, SYSTEMD_UNIT]);
    deps.out(
      action === "start"
        ? "Started the capybara-device login service."
        : action === "restart"
          ? "Restarted the capybara-device login service."
          : "Stopped the capybara-device login service; running commands ended. It starts again at the next login or with: capybara-device service start",
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
