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

export function isAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running program, or undefined (no file, a stale one, or a file that is not a pid). */
export function readRunning(
  dir: string,
  kill: typeof process.kill = process.kill,
): RunningProgram | undefined {
  const file = pidPath(dir);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8").trim();
  let pid: number;
  let version: string | undefined;
  let startedAt: string | undefined;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; version?: unknown; startedAt?: unknown };
      pid = Number(parsed.pid);
      version = typeof parsed.version === "string" ? parsed.version : undefined;
      startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : undefined;
    } catch {
      return undefined;
    }
  } else {
    // A program older than the version field wrote a bare pid: its version is unknown.
    pid = Number.parseInt(raw, 10);
  }
  return Number.isInteger(pid) && pid > 0 && isAlive(pid, kill)
    ? {
        pid,
        ...(version !== undefined && { version }),
        ...(startedAt !== undefined && { startedAt }),
      }
    : undefined;
}

/** The pid of the running program, or undefined (no file, or a stale one). */
export function readRunningPid(
  dir: string,
  kill: typeof process.kill = process.kill,
): number | undefined {
  return readRunning(dir, kill)?.pid;
}

export function writePid(dir: string, pid: number, version?: string): void {
  const entry: RunningProgram = {
    pid,
    ...(version !== undefined && { version }),
    startedAt: new Date().toISOString(),
  };
  writePrivate(pidPath(dir), `${JSON.stringify(entry)}\n`);
}

/** The pid a pid file names, without asking whether it is alive. */
function pidInFile(file: string): number | undefined {
  const raw = readFileSync(file, "utf8").trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      return Number(parsed.pid);
    } catch {
      return undefined;
    }
  }
  return Number.parseInt(raw, 10);
}

export function removePid(dir: string, pid: number): void {
  const file = pidPath(dir);
  try {
    if (pidInFile(file) === pid) rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
