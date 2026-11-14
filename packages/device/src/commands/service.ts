import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunningPid } from "../pid.js";
import { LAUNCHD_LABEL, plistContent, plistPath, type ServiceSpec } from "../service/launchd.js";
import { SYSTEMD_UNIT, unitContent, unitPath } from "../service/systemd.js";

export type ServiceAction = "install" | "uninstall" | "status";

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

/** One status report, once the caller knows whether launchd/systemd has the service loaded. */
function reportStatus(deps: ServiceDeps, loaded: boolean): number {
  if (!loaded) {
    deps.out("capybara-device service is not loaded. Install it: capybara-device service install");
    return 1;
  }
  const pid = readRunningPid(deps.stateDir);
  if (pid === undefined) {
    deps.out("capybara-device service is loaded, but no capybara-device process is running.");
    return 1;
  }
  deps.out(`capybara-device service is loaded; capybara-device is running (pid ${pid}).`);
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
  if (action === "status") return reportStatus(deps, loaded());
  /** Boots the service out and waits until launchd has let it go (bootout returns before that). */
  const bootout = async (): Promise<void> => {
    tryRun(["bootout", service]);
    for (let waited = 0; loaded(); waited += SERVICE_POLL_MS) {
      // Gave up: bootstrap's retries cover what is left.
      if (waited >= SERVICE_GONE_TIMEOUT_MS) return;
      await sleep(SERVICE_POLL_MS);
    }
  };
  if (action === "install") {
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(spec.stateDir, { recursive: true });
    if (existsSync(file) || loaded()) await bootout();
    writeFileSync(file, plistContent(spec));
    for (let attempt = 0; ; attempt++) {
      try {
        run("launchctl", ["bootstrap", domain, file]);
        break;
      } catch (e) {
        if (!isBootstrapIoError(e)) throw e;
        const backoff = BOOTSTRAP_BACKOFF_MS[attempt];
        if (backoff === undefined) {
          deps.err(
            `capybara-device service install failed: launchctl bootstrap failed ${attempt + 1} times (${failureText(e)}). ` +
              `The previous capybara-device service may still be stopping: wait a few seconds and run capybara-device service install again. ` +
              `launchctl print ${service} shows what launchd knows of it.`,
          );
          return 1;
        }
        await sleep(backoff);
        await bootout();
      }
    }
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
  if (action === "status") {
    let active = false;
    try {
      run("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]);
      active = true;
    } catch {
      // Inactive or not installed.
    }
    return reportStatus(deps, active);
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
