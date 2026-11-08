import type { BackgroundFinish } from "./finish.js";
import { TASK_ID_RE, TASKS_DIR } from "./launch.js";
import { decodeTail, killSessionScript, SID_RE, tailCommand } from "./session.js";
import { exitedAs } from "./stop.js";
import type { BackgroundTaskRow } from "./store.js";

/*
 * A running task's status as seen inside its sandbox (spec 2026-11-05-background-bash-design
 * §4.3): its exit file and whether its session still has a process. Shared by the poller
 * (`BackgroundTaskPollJob`, one exec per sandbox) and `TaskOutput` (one task per exec).
 */

/** What the poll exec reports for one task. */
export interface TaskReport {
  /** The exit file's code; null while there is none. */
  exitCode: number | null;
  /**
   * Whether the session still has a process: `pgrep -s <sid>`, or, for a task whose command
   * exited, whether its leftover processes could not be confirmed killed.
   */
  alive: boolean;
  /** The last lines (decoded), read when the task exited or no process was left. */
  lastLines: string;
}

/**
 * The poll exec of one sandbox: for every task one line `<id> <exit code or -> <1|0> <tail or ->`.
 * Liveness is asked before the exit file: a task ending in between is seen by its exit file, never
 * as a task without process and exit file. A task whose command exited while its session still has
 * processes (it left `server &` running) has the session killed in the same exec (so under the
 * caller's lease), and is reported without a process once the session was confirmed empty: the
 * task ends when its command exits, and nothing of it runs on untracked. The tail (base64) is read
 * only for a task that exited or has no process left. Relative to the workspace root.
 */
export function pollScript(tasks: { id: string; sid: string }[]): string {
  const lines = tasks.map(({ id, sid }) => {
    if (!TASK_ID_RE.test(id) || !SID_RE.test(sid)) {
      throw new Error(`invalid background task ${JSON.stringify(id)} / ${JSON.stringify(sid)}`);
    }
    const f = `${TASKS_DIR}/${id}`;
    return [
      `if pgrep -s ${sid} >/dev/null 2>&1; then a=1; else a=0; fi`,
      `if [ -s ${f}.exit ]; then c=$(tr -dc '0-9-' < ${f}.exit); else c=-; fi`,
      `[ -n "$c" ] || c=-`,
      `if [ "$c" != - ] && [ "$a" = 1 ]; then ${killSessionScript(sid)}; [ "$ks" = 0 ] && a=0; fi`,
      `if [ "$c" != - ] || [ "$a" = 0 ]; then t=$(${tailCommand(id)}); else t=; fi`,
      `echo "${id} $c $a \${t:--}"`,
    ].join("\n");
  });
  return lines.join("\n");
}

/** Parses {@link pollScript}'s output; a task missing from it is absent from the map. */
export function parsePollOutput(stdout: string): Map<string, TaskReport> {
  const out = new Map<string, TaskReport>();
  for (const line of stdout.split("\n")) {
    const m = /^(bt_[a-z2-7]{6}) (-?[0-9]+|-) ([01]) (\S+)$/.exec(line.trim());
    if (!m) continue;
    const [, id, code, alive, tail] = m as unknown as [string, string, string, string, string];
    out.set(id, {
      exitCode: code === "-" ? null : Number(code),
      alive: alive === "1",
      lastLines: tail === "-" ? "" : decodeTail(tail),
    });
  }
  return out;
}

/**
 * How a polled task ends, or null while it runs (spec §4.3). A task whose command exited but whose
 * leftover processes could not be confirmed killed ({@link pollScript}) stays running: the next
 * poll kills them again before it finishes.
 */
export function polledAs(
  task: BackgroundTaskRow,
  r: TaskReport,
  now: Date,
): BackgroundFinish | null {
  if (r.exitCode !== null) return r.alive ? null : exitedAs(task, r.exitCode, now);
  if (r.alive) return null;
  return { status: "lost", lostReason: "process_gone", killPending: false };
}
