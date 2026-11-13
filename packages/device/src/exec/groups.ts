import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

/** How often process groups of finished commands are checked for remaining members. */
const PRUNE_INTERVAL_MS = 5_000;

/**
 * The key that marks every process of one device directory's commands (`<dirKey>.<tag>` in the
 * marker variable). Executors of the same directory compute the same key, so either one finds
 * and kills what the other started.
 */
export function dirKeyOf(realDir: string): string {
  return createHash("sha256").update(realDir).digest("hex").slice(0, 16);
}

/** Sends `signal` (SIGKILL by default) to a process group; false when the group no longer exists. */
export function killGroupId(pgid: number, signal: NodeJS.Signals | 0 = "SIGKILL"): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One command's process group. It is tracked after the command's main process exits, as long as
 * the group has members (background children), so killTagged / killAll still reach them.
 */
export interface Group {
  tag: string;
  pgid: number;
  /** The leader (the outer shell) has exited and been reaped. */
  exited: boolean;
  /** Called by a kill while the command runs: the result then has `exitCode: null`. */
  onKill?: (() => void) | undefined;
}

/** The process groups of one executor's commands (each command leads its own group). */
export class GroupTracker {
  private readonly groups = new Set<Group>();
  private pruneTimer: NodeJS.Timeout | undefined;

  /** Tracks a spawned command's process group; undefined when it has no pid (spawn failed). */
  track(tag: string, child: ChildProcess): Group | undefined {
    if (child.pid === undefined) return undefined;
    const g: Group = { tag, pgid: child.pid, exited: false };
    this.groups.add(g);
    if (this.pruneTimer === undefined) {
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
    return g;
  }

  /** Stops tracking a group (its command failed to start). */
  forget(g: Group): void {
    this.groups.delete(g);
  }

  /** Forgets finished groups with no members left (or whose id was taken by another process). */
  prune(): void {
    for (const g of this.groups) {
      if (!g.exited) continue;
      // A reaped leader's pid can be reused only once its group is gone: a live process with
      // that pid means the id now belongs to someone else.
      if (pidAlive(g.pgid) || !killGroupId(g.pgid, 0)) this.groups.delete(g);
    }
    this.stopTimerWhenEmpty();
  }

  kill(g: Group): void {
    if (g.exited) {
      this.prune();
      if (!this.groups.has(g)) return;
    }
    g.onKill?.();
    if (!killGroupId(g.pgid) && g.exited) this.groups.delete(g);
  }

  /** Kills the groups of the given tags. */
  killTags(tags: Iterable<string>): void {
    const want = new Set(tags);
    for (const g of [...this.groups]) if (want.has(g.tag)) this.kill(g);
  }

  killAll(): void {
    for (const g of [...this.groups]) this.kill(g);
  }

  /** Stops the prune timer (the groups stay known). */
  dispose(): void {
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }

  /** The number of groups tracked (for tests). */
  get size(): number {
    return this.groups.size;
  }

  private stopTimerWhenEmpty(): void {
    if (this.groups.size === 0 && this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}
