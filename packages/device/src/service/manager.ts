import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasLoginService } from "./installed.js";
import { LAUNCHD_LABEL, plistBinPath, plistPath } from "./launchd.js";
import { SYSTEMD_UNIT, unitBinPath, unitPath } from "./systemd.js";

/**
 * Runs a system command and returns its standard output; throws when it fails (the default,
 * execFileSync, throws an error carrying the exit `status` and `stderr`).
 */
export type RunSystem = (cmd: string, args: string[]) => string;

export function defaultRunSystem(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
}

/** Where the login service lives: the user's home, the platform, and (macOS) the GUI domain's uid. */
export interface ServiceWhere {
  home: string;
  platform: NodeJS.Platform;
  uid?: number;
}

/** The launchd domain and service target of the agent. */
export function launchdTarget(uid: number | undefined): { domain: string; service: string } {
  const domain = `gui/${uid ?? process.getuid?.() ?? 501}`;
  return { domain, service: `${domain}/${LAUNCHD_LABEL}` };
}

/**
 * What the service manager says of the login service: whether launchd has it loaded (systemd:
 * whether the unit is active), and the pid of the program it runs now, if any.
 */
export interface ManagerState {
  loaded: boolean;
  pid?: number;
}

/** The job's own `pid = N` line in `launchctl print` output (absent while it is not running). */
function launchdPid(printed: string): number | undefined {
  const m = /^\s*pid = (\d+)\s*$/m.exec(printed);
  const pid = m === null ? Number.NaN : Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Asks launchd or systemd about the login service; a manager that cannot be asked says "not loaded". */
export function managerState(where: ServiceWhere, run: RunSystem): ManagerState {
  if (where.platform === "darwin") {
    try {
      const printed = run("launchctl", ["print", launchdTarget(where.uid).service]);
      const pid = launchdPid(String(printed ?? ""));
      return { loaded: true, ...(pid !== undefined && { pid }) };
    } catch {
      return { loaded: false };
    }
  }
  if (where.platform === "linux") {
    try {
      run("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]);
    } catch {
      return { loaded: false };
    }
    try {
      const out = run("systemctl", ["--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT]);
      const pid = Number(String(out ?? "").trim());
      return { loaded: true, ...(Number.isInteger(pid) && pid > 0 && { pid }) };
    } catch {
      return { loaded: true };
    }
  }
  return { loaded: false };
}

/** The bin script the installed service file runs, or undefined (no file, or unreadable). */
export function serviceBinPath(where: ServiceWhere): string | undefined {
  if (!hasLoginService(where.home, where.platform)) return undefined;
  try {
    if (where.platform === "darwin") {
      return plistBinPath(readFileSync(plistPath(where.home), "utf8"));
    }
    return unitBinPath(readFileSync(unitPath(where.home), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The version of the package at `binPath` (`<package>/bin/capybara-device.mjs`), read from its
 * `package.json`: what a restart of the service would run. Undefined when it cannot be read.
 */
export function packageVersionAt(binPath: string): string | undefined {
  try {
    const raw = readFileSync(join(dirname(dirname(binPath)), "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this process was started by the service manager: launchd sets `XPC_SERVICE_NAME` to the
 * agent's label (a terminal on macOS sets it to `0` or the terminal app's), systemd sets
 * `INVOCATION_ID`. A shell inside a systemd-run terminal inherits `INVOCATION_ID` too; systemd 248+
 * also sets `SYSTEMD_EXEC_PID`, which names this process only when systemd started it.
 */
export function startedByServiceManager(
  env: Record<string, string | undefined>,
  pid: number = process.pid,
): boolean {
  if (env.XPC_SERVICE_NAME === LAUNCHD_LABEL) return true;
  if ((env.INVOCATION_ID ?? "") === "") return false;
  return env.SYSTEMD_EXEC_PID === undefined || env.SYSTEMD_EXEC_PID === String(pid);
}
