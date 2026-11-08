import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "./state.js";

export function pidPath(dir: string): string {
  return join(dir, "capybara-device.pid");
}

export function isAlive(pid: number, kill: typeof process.kill = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid of the running program, or undefined (no file, or a stale one). */
export function readRunningPid(
  dir: string,
  kill: typeof process.kill = process.kill,
): number | undefined {
  const file = pidPath(dir);
  if (!existsSync(file)) return undefined;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 && isAlive(pid, kill) ? pid : undefined;
}

export function writePid(dir: string, pid: number): void {
  writePrivate(pidPath(dir), `${pid}\n`);
}

export function removePid(dir: string, pid: number): void {
  const file = pidPath(dir);
  try {
    if (Number.parseInt(readFileSync(file, "utf8").trim(), 10) === pid)
      rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
