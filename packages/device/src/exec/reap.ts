import { killGroupId } from "./groups.js";
import { findMarked } from "./procs.js";

/** The most scans one batch of reaps makes while it still finds processes. */
export const REAP_ROUNDS = 3;

export interface ReaperDeps {
  /** SIGKILLs a process group; false when it no longer exists. */
  killGroup: (pgid: number) => boolean;
  /** The pids of this user's processes whose marker value `match` accepts (see `procs.ts`). */
  findMarked: (match: (value: string) => boolean) => Promise<number[]>;
  /** SIGKILLs one process and the process group it leads, if any. */
  killPid: (pid: number) => void;
}

function killPid(pid: number): void {
  // A live process's pid is a group id only when it leads that group: then the group goes too.
  killGroupId(pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const DEFAULT_DEPS: ReaperDeps = { killGroup: (pgid) => killGroupId(pgid), findMarked, killPid };

/**
 * Kills what a foreground exec left running once it ended (normal exit, timeout or abort). Inside
 * the OS sandbox a command can neither list nor signal the processes another command started, so
 * a `sleep 300 &` or `nohup server &` left behind could otherwise be stopped by nobody.
 *
 * The exec's process group goes at once (a `&` or `nohup` child stays in it). A process that left
 * the group (`setsid`, a detached spawn) is found by the exec's own marker value, which every
 * process it starts inherits; listing processes is slow on macOS (`ps -E`), so that part runs
 * after the result and reaps that arrive meanwhile share one scan. On macOS `ps -E` hides the
 * environment of Apple platform binaries, so it is best effort there (the group covers the rest).
 * Background task launches are not reaped at all (`isBackgroundLaunch`): they detach on purpose.
 */
export class Reaper {
  private readonly deps: ReaperDeps;
  /** Markers whose processes the next scan kills. */
  private readonly pending = new Set<string>();
  /** The queued scan (not started yet), which every new reap joins. */
  private next: Promise<void> | undefined;
  /** The scan in progress. */
  private running: Promise<void> | undefined;

  constructor(deps: Partial<ReaperDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /**
   * SIGKILLs the process group `pgid` now and, soon after, every process carrying the marker
   * value `marker` exactly (none when empty). Resolves once that scan is done; never rejects.
   */
  reap(pgid: number, marker: string): Promise<void> {
    this.deps.killGroup(pgid);
    if (marker === "") return Promise.resolve();
    this.pending.add(marker);
    return this.schedule();
  }

  private schedule(): Promise<void> {
    if (this.next !== undefined) return this.next;
    const queued = this.runQueued();
    this.next = queued;
    return queued;
  }

  /** Waits for the scan in progress, then scans every marker pending by then. */
  private async runQueued(): Promise<void> {
    // Always yields first, so `schedule` has set `this.next` before it is cleared here.
    await (this.running ?? Promise.resolve()).catch(() => {});
    this.next = undefined;
    const markers = new Set(this.pending);
    this.pending.clear();
    const scan = this.scan(markers);
    this.running = scan;
    try {
      await scan;
    } finally {
      if (this.running === scan) this.running = undefined;
    }
  }

  private async scan(markers: Set<string>): Promise<void> {
    for (let round = 0; round < REAP_ROUNDS; round++) {
      let pids: number[];
      try {
        pids = await this.deps.findMarked((v) => markers.has(v));
      } catch {
        return;
      }
      if (pids.length === 0) return;
      for (const pid of pids) this.deps.killPid(pid);
    }
  }
}
