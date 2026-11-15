import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./state.js";

export function pidPath(dir: string): string {
  return join(dir, "capybara-device.pid");
}

/**
 * The program a pid file names: its pid, and — for a program that wrote the file since this
 * change — the version it runs and when it started (`service status` compares the version with the
 * installed package, so a stale daemon after an upgrade says so instead of looking healthy).
 */
export type RunningProgram = {
  pid: number;
  version?: string;
  startedAt?: string;
};

/** What `ps` tells of a process: its command line and, when known, when it started. */
export interface ProcessInfo {
  command: string;
  started?: Date;
}

/** Looks a process up by pid (default: `ps`); undefined when there is no such process. */
export type ProcessLookup = (pid: number) => ProcessInfo | undefined;

/** How a pid is checked: `kill(pid, 0)` for liveness, `ps` for what the process is. */
export interface ProcessChecks {
  kill?: typeof process.kill;
  ps?: ProcessLookup;
}

/** The name every command line of this program contains (`…/bin/capybara-device.mjs start`). */
export const PROGRAM_BIN = "capybara-device";

/**
 * How much later than the pid file's `startedAt` the process may seem to have started: `ps`
 * reports whole seconds, and Linux derives the time from a boot time rounded to the second.
 */
const START_SLACK_MS = 2000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parses `ps -o lstart= -o command=` output (C locale): `Sat Nov 14 02:11:37 2026 <command>`, the
 * start in local time. A line without a readable start keeps only the command.
 */
export function parsePsOutput(output: string): ProcessInfo | undefined {
  const line = output.split("\n").find((l) => l.trim() !== "");
  if (line === undefined) return undefined;
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/.exec(
    line,
  );
  const month = m === null ? -1 : MONTHS.indexOf(m[1] ?? "");
  if (m === null || month < 0) return { command: line.trim() };
  const [, , day, h, min, s, year, command] = m;
  return {
    command: (command ?? "").trim(),
    started: new Date(Number(year), month, Number(day), Number(h), Number(min), Number(s)),
  };
}

/** The default {@link ProcessLookup}: one `ps` call in the C locale. */
export function psLookup(pid: number): ProcessInfo | undefined {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    return parsePsOutput(output);
  } catch {
    // ps exits 1 when no such process exists.
    return undefined;
  }
}

export function isAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The entry a pid file holds: JSON `{pid, version, startedAt}`, or a bare pid from a program older
 * than the version field. Undefined when it is neither.
 */
export function parsePidFile(raw: string): RunningProgram | undefined {
  const text = raw.trim();
  let pid: number;
  let version: string | undefined;
  let startedAt: string | undefined;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { pid?: unknown; version?: unknown; startedAt?: unknown };
      pid = Number(parsed.pid);
      version = typeof parsed.version === "string" ? parsed.version : undefined;
      startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : undefined;
    } catch {
      return undefined;
    }
  } else {
    pid = Number.parseInt(text, 10);
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    ...(version !== undefined && { version }),
    ...(startedAt !== undefined && { startedAt }),
  };
}

/**
 * Whether the process `entry` names is this program: its command line contains the
 * `capybara-device` bin, and it did not start after the pid file was written (a reused pid did).
 * A file without `startedAt` (an older program) is checked by the command line alone.
 */
function namesThisProgram(entry: RunningProgram, ps: ProcessLookup): boolean {
  const info = ps(entry.pid);
  if (info === undefined || !info.command.includes(PROGRAM_BIN)) return false;
  if (entry.startedAt === undefined) return true;
  const written = Date.parse(entry.startedAt);
  if (Number.isNaN(written) || info.started === undefined) return false;
  return info.started.getTime() <= written + START_SLACK_MS;
}

/**
 * The running program, or undefined: no file, a file that is not a pid, a dead pid, or a pid that
 * is not this program any more (see {@link namesThisProgram}). Nothing signals an unverified pid.
 */
export function readRunning(dir: string, checks: ProcessChecks = {}): RunningProgram | undefined {
  const file = pidPath(dir);
  if (!existsSync(file)) return undefined;
  const entry = parsePidFile(readFileSync(file, "utf8"));
  if (entry === undefined || !isAlive(entry.pid, checks.kill)) return undefined;
  return namesThisProgram(entry, checks.ps ?? psLookup) ? entry : undefined;
}

/** The pid of the running program, or undefined (see {@link readRunning}). */
export function readRunningPid(dir: string, checks: ProcessChecks = {}): number | undefined {
  return readRunning(dir, checks)?.pid;
}

export function writePid(dir: string, pid: number, version?: string): void {
  const entry: RunningProgram = {
    pid,
    ...(version !== undefined && { version }),
    startedAt: new Date().toISOString(),
  };
  writePrivate(pidPath(dir), `${JSON.stringify(entry)}\n`);
}

export function removePid(dir: string, pid: number): void {
  const file = pidPath(dir);
  try {
    if (parsePidFile(readFileSync(file, "utf8"))?.pid === pid) rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
