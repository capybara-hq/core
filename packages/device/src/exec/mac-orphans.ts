import { execFile } from "node:child_process";
import type { TrustedLaunchIdentity } from "./operation-worker.js";

/** One live process as the process table reports it (zombies and exiting processes left out). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /**
   * Start time in epoch milliseconds, truncated to the second as `ps` reports it: the process
   * started somewhere in `[startMs, startMs + 1000)`.
   */
  startMs: number;
}
/** The process table and the signals the reaper sends. Trusted construction input. */
export interface OrphanProcesses {
  /** A snapshot of every live process; throws when the table cannot be read. */
  list(): Promise<ProcessRow[]>;
  /** Sends `signal` to one process (ESRCH counts as success). */
  signal(pid: number, signal: "SIGSTOP" | "SIGKILL"): void;
  /** SIGKILL to the whole process group `pgid` (ESRCH counts as success). */
  killGroup(pgid: number): void;
  /** Waits a short moment between checks of a killed tree (never used to decide anything). */
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
 * How long before its recorded launch time a launched process may have started and still be
 * proven ours: the time is taken next to the spawn (the worker, or the native launch callback),
 * so the gap is an event loop turn; a minute bounds what a stepped clock could make look ours.
 */
export const LAUNCH_SLACK_MS = 60_000;
/**
 * A launch identity of an earlier device version has no launch time; its spawn followed the
 * admission check within an IPC send. Only a leader that started this long after the admission
 * deadline is certainly another process.
 */
export const LEGACY_MARGIN_MS = 60 * 60 * 1000;
const SECOND = 1000;

/**
 * Every launch is a detached spawn (`setsid`): the launched process leads its own session and
 * process group, so pid = pgid, and a session leader can never move to another group. While the
 * launched process lives its pid cannot be handed out again, so a leader at that pid that started
 * at or before the recorded launch time is the launched one, within {@link LAUNCH_SLACK_MS} (a
 * stepped clock aside). One that certainly started after it (its truncated start is already
 * later) is another process: the launched one is gone. One that looks older than the window is
 * unprovable, never gone: a late record or a stepped clock can make a live leader look too old.
 *
 * A launch identity of an earlier device version has no launch time: a leader that started more
 * than {@link LEGACY_MARGIN_MS} after the admission deadline is another process, any other
 * leader is unprovable.
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
    // certainly started after the launch (even its truncated start is later)
    if (leader.startMs > identity.launchedAtMs) return "gone";
    // possibly started inside the window (its latest possible start reaches it)
    if (leader.startMs + SECOND > identity.launchedAtMs - LAUNCH_SLACK_MS) return "ours";
    return "unprovable";
  }
  return leader.startMs > admitBeforeMs + LEGACY_MARGIN_MS ? "gone" : "unprovable";
}

/** The most one reap waits for a killed tree to disappear before it gives up (retried later). */
const KILL_VERIFY_ATTEMPTS = 100;
/** The most rounds a tree walk takes to stop every descendant (as the live stop path does). */
const FREEZE_ROUNDS = 64;
/**
 * A signal whose failure decides nothing: a group of only zombies answers EPERM on macOS, a
 * process may exit in between. What counts is the table afterwards (see reapOrphans).
 */
const attempt = (send: () => void) => {
  try {
    send();
  } catch {}
};

/**
 * Stops the whole tree of a leader proven ours, then kills it: the leader, every member of its
 * group and every descendant (a command can leave the group with `setsid`, by daemonizing or with
 * job control). Each round reads the table afresh and re-proves the leader before signalling
 * anything; a stopped process can neither exit (its children keep their parent link) nor fork.
 * Returns the processes signalled (pid → start) or "gone" when the leader was no longer ours.
 */
async function freezeAndKill(
  processes: OrphanProcesses,
  identity: TrustedLaunchIdentity,
  admitBeforeMs: number,
): Promise<Map<number, number> | OrphanVerdict> {
  const frozen = new Map<number, number>();
  let rows: ProcessRow[] = [];
  let leaderOurs = false;
  for (let round = 0; round < FREEZE_ROUNDS; round++) {
    rows = await processes.list();
    // re-proved on every read, the last one just before the kill
    const verdict = orphanVerdict(identity, admitBeforeMs, rows);
    leaderOurs = verdict === "ours";
    if (!leaderOurs) {
      if (frozen.size === 0) return verdict;
      // the stopped leader was killed by someone else: what was already stopped was proven ours
      // and cannot have exited (stopped), so it is still killed below, by pid and start time
      break;
    }
    const found = rows.filter(
      (row) =>
        !frozen.has(row.pid) &&
        (row.pid === identity.pid || row.pgid === identity.pid || frozen.has(row.ppid)),
    );
    if (!found.length) break;
    for (const row of found) {
      attempt(() => processes.signal(row.pid, "SIGSTOP"));
      frozen.set(row.pid, row.startMs);
    }
  }
  for (const row of rows)
    if (frozen.get(row.pid) === row.startMs) attempt(() => processes.signal(row.pid, "SIGKILL"));
  // the group only while its leader is still proven ours on the latest read
  if (leaderOurs) attempt(() => processes.killGroup(identity.pid));
  return frozen;
}

/**
 * Settles recorded launch identities left by an earlier program run (or by workers of this one
 * that already ended): for each, true once nothing of it can still run. A leader proven ours is
 * stopped and killed with its whole tree, and true comes only after the table shows none of that
 * tree and no member of its group; a kill that fails or does not take within the bound leaves
 * false (retried by a later pass). Nothing unprovable is ever signalled.
 */
export async function reapOrphans(
  processes: OrphanProcesses,
  items: readonly { identity: TrustedLaunchIdentity; admitBeforeMs: number }[],
): Promise<boolean[]> {
  const table = await processes.list();
  const settled: (boolean | undefined)[] = [];
  const killed = new Map<number, Map<number, number>>();
  for (const [i, { identity, admitBeforeMs }] of items.entries()) {
    const verdict = orphanVerdict(identity, admitBeforeMs, table);
    if (verdict !== "ours") {
      settled[i] = verdict === "gone";
      continue;
    }
    try {
      const outcome = await freezeAndKill(processes, identity, admitBeforeMs);
      if (outcome instanceof Map) killed.set(i, outcome);
      else settled[i] = outcome === "gone";
    } catch {
      settled[i] = false;
    }
  }
  const remains = (rows: readonly ProcessRow[], pgid: number, tree: Map<number, number>) =>
    rows.some((row) => row.pgid === pgid || tree.get(row.pid) === row.startMs);
  for (let attempt = 0; killed.size && attempt < KILL_VERIFY_ATTEMPTS; attempt++) {
    const rows = await processes.list();
    for (const [i, tree] of killed)
      if (!remains(rows, (items[i] as (typeof items)[number]).identity.pid, tree)) {
        killed.delete(i);
        settled[i] = true;
      }
    if (killed.size) await processes.pause();
  }
  return items.map((_, i) => settled[i] === true);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `lstart` as `ps` prints it in the C locale with `TZ=UTC0`: `Sat Nov 21 04:59:07 2026`. */
function parseUtcStart(text: string): number | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1] as string);
  if (month < 0) return undefined;
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(year, month, day, hours, minutes, seconds);
}

/**
 * Parses `ps -axo pid=,ppid=,pgid=,stat=,lstart=` (C locale, UTC); zombies and exiting processes
 * dropped. UTC has no repeated hour, so no start time is ambiguous.
 */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, stat, lstart] = match as unknown as string[];
    if (stat?.startsWith("Z") || stat?.includes("E")) continue;
    const startMs = parseUtcStart(lstart as string);
    if (startMs === undefined) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startMs });
  }
  return rows;
}

const ignoreGone = (send: () => void) => {
  try {
    send();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
/** The macOS process table through `/bin/ps`. */
export const macOrphanProcesses: OrphanProcesses = {
  list: () =>
    new Promise((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { LC_ALL: "C", TZ: "UTC0" },
        },
        (error, stdout) => (error ? reject(error) : resolve(parseProcessTable(stdout))),
      );
    }),
  signal: (pid, signal) => ignoreGone(() => process.kill(pid, signal)),
  killGroup: (pgid) => ignoreGone(() => process.kill(-pgid, "SIGKILL")),
  pause: () => new Promise((resolve) => setTimeout(resolve, 50)),
};
