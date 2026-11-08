import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/** The environment variable every sandboxed command (and everything it starts) carries. */
export const EXEC_MARKER = "CAPYBARA_EXEC";

const MARKER_RE = new RegExp(`(?:^|\\s)${EXEC_MARKER}=(\\S+)`, "g");

function psLines(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-E", "-ww", "-U", String(process.getuid?.() ?? ""), "-o", "pid=,command="],
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout ?? ""),
    );
  });
}

/**
 * The pids of this user's processes whose environment carries {@link EXEC_MARKER} with a value
 * `match` accepts. Linux reads `/proc/<pid>/environ` (exact). macOS reads `ps -E`, which shows
 * the environment of ordinary programs but not of Apple platform binaries (`/bin/sleep`), so it
 * is best effort there; process groups cover the rest (see the OS executor).
 */
export async function findMarked(match: (value: string) => boolean): Promise<number[]> {
  const found = new Set<number>();
  if (process.platform === "linux") {
    let entries: string[] = [];
    try {
      entries = await readdir("/proc");
    } catch {
      return [];
    }
    await Promise.all(
      entries
        .filter((e) => /^\d+$/.test(e))
        .map(async (e) => {
          try {
            const env = await readFile(`/proc/${e}/environ`, "latin1");
            for (const kv of env.split("\0")) {
              if (kv.startsWith(`${EXEC_MARKER}=`) && match(kv.slice(EXEC_MARKER.length + 1))) {
                found.add(Number(e));
              }
            }
          } catch {
            // Gone, or not ours.
          }
        }),
    );
  } else if (process.platform === "darwin") {
    for (const line of (await psLines()).split("\n")) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (!m) continue;
      for (const v of (m[2] as string).matchAll(MARKER_RE)) {
        if (match(v[1] as string)) found.add(Number(m[1]));
      }
    }
  }
  found.delete(process.pid);
  return [...found];
}

/** SIGKILLs every process {@link findMarked} finds for `match`. */
export async function killMarked(match: (value: string) => boolean): Promise<void> {
  for (const pid of await findMarked(match)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
