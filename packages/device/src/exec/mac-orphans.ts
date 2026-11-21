import { execFile } from "node:child_process";
import type { TrustedLaunchIdentity } from "./operation-worker.js";

/** One live process as the process table reports it (zombies and exiting processes left out). */
export interface ProcessRow {
  pid: number;
  pgid: number;
  /** Start time in epoch milliseconds, truncated to the second as `ps` reports it. */
  startMs: number;
}
/** The process table and the one signal the reaper sends. Trusted construction input. */
export interface OrphanProcesses {
  /** A snapshot of every live process; throws when the table cannot be read. */
  list(): Promise<ProcessRow[]>;
  /** SIGKILL to the whole process group `pgid` (ESRCH counts as success). */
  killGroup(pgid: number): void;
  /** Waits a short moment between checks of a killed group (never used to decide anything). */
  pause(): Promise<void>;
}
/**
 * What the launch identity recorded for an entry proves about its process now:
 * - `gone`: nothing of it can still run (no leader and no member of its process group, or the pid
 *   now belongs to a process that provably is not the one launched);
 * - `ours`: the recorded leader still runs and provably is the launched process;
 * - `unprovable`: something may still run but cannot be proven ours (never killed, never settled).
 */
export type OrphanVerdict = "gone" | "ours" | "unprovable";
/**
 * How far before the recorded launch time the launched process may have started: the identity is
 * recorded right after the spawn (an IPC round trip, an event loop turn), so a generous minute.
 */
export const LAUNCH_SLACK_MS = 60_000;

/**
 * Every launch is a detached spawn (`setsid`): the launched process leads its own session and
 * process group, so pid = pgid, and a session leader can never move to another group. A process
 * at that pid is the launched one only while it still leads its group and started within the
 * launch window: from {@link LAUNCH_SLACK_MS} before the recorded launch time up to that time
 * (the spawn precedes the record). A launch identity of an earlier device version has no launch
 * time; its launch still preceded the admission deadline (checked just before the spawn), so a
 * process that started well after it is not the launched one, and one that started before it
 * cannot be told apart from it: unprovable.
 *
 * With the leader gone, a member still in the group cannot be proven ours (the group outlived its
 * leader, or a later process reused the pid as a group): unprovable.
 */
export function orphanVerdict(
  identity: TrustedLaunchIdentity,
  admitBeforeMs: number,
  table: readonly ProcessRow[],
): OrphanVerdict {
  const leader = table.find((row) => row.pid === identity.pid);
  const members = table.some((row) => row.pgid === identity.pid && row.pid !== identity.pid);
  if (!leader) return members ? "unprovable" : "gone";
  // the pid is in use by another process: ours, if it ever existed, is gone, and so is its group
  // (a pid is never handed out while a group of that id exists)
  if (leader.pgid !== identity.pid) return "gone";
  if (identity.launchedAtMs !== undefined) {
    const earliest = Math.floor((identity.launchedAtMs - LAUNCH_SLACK_MS) / 1000) * 1000;
    return leader.startMs >= earliest && leader.startMs <= identity.launchedAtMs ? "ours" : "gone";
  }
  return leader.startMs >= admitBeforeMs + LAUNCH_SLACK_MS ? "gone" : "unprovable";
}

/** The most one reap waits for a killed group to disappear before it gives up (retried later). */
const KILL_VERIFY_ATTEMPTS = 100;

/**
 * Settles recorded launch identities left by an earlier program run (or by workers of this one
 * that already ended): for each, true once nothing of it can still run. A provably ours leader is
 * killed with its whole process group, and true comes only after the table shows the group gone;
 * a kill that fails or does not take within the bound leaves false (retried by a later pass).
 */
export async function reapOrphans(
  processes: OrphanProcesses,
  items: readonly { identity: TrustedLaunchIdentity; admitBeforeMs: number }[],
): Promise<boolean[]> {
  const table = await processes.list();
  const settled = items.map(({ identity, admitBeforeMs }) => {
    const verdict = orphanVerdict(identity, admitBeforeMs, table);
    return verdict === "ours" ? undefined : verdict === "gone";
  });
  const killed = new Set<number>();
  items.forEach(({ identity }, i) => {
    if (settled[i] !== undefined) return;
    try {
      processes.killGroup(identity.pid);
      killed.add(identity.pid);
    } catch {
      settled[i] = false;
    }
  });
  const present = (rows: readonly ProcessRow[], pgid: number) =>
    rows.some((row) => row.pid === pgid || row.pgid === pgid);
  for (let attempt = 0; killed.size && attempt < KILL_VERIFY_ATTEMPTS; attempt++) {
    const rows = await processes.list();
    for (const pgid of killed) if (!present(rows, pgid)) killed.delete(pgid);
    if (killed.size) await processes.pause();
  }
  return items.map(({ identity }, i) => settled[i] ?? !killed.has(identity.pid));
}

/** Parses `ps -axo pid=,pgid=,stat=,lstart=` (C locale); zombies and exiting processes dropped. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, pgid, stat, lstart] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (stat.startsWith("Z") || stat.includes("E")) continue;
    const startMs = Date.parse(lstart);
    if (!Number.isFinite(startMs)) continue;
    rows.push({ pid: Number(pid), pgid: Number(pgid), startMs });
  }
  return rows;
}

/** The macOS process table through `/bin/ps`. */
export const macOrphanProcesses: OrphanProcesses = {
  list: () =>
    new Promise((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-axo", "pid=,pgid=,stat=,lstart="],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { LC_ALL: "C", ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
        },
        (error, stdout) => (error ? reject(error) : resolve(parseProcessTable(stdout))),
      );
    }),
  killGroup: (pgid) => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
  pause: () => new Promise((resolve) => setTimeout(resolve, 50)),
};
