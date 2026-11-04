import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { type BackgroundFinish, BackgroundTaskFinisher } from "./finish.js";
import { TASK_ID_RE, TASKS_DIR } from "./launch.js";
import { decodeTail, SID_RE, tailCommand } from "./session.js";
import { exitedAs, notRunningAs, RECREATED } from "./stop.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "./store.js";

/** The poll of the running background tasks (`@LockedInterval`, every `pollSeconds`). */
export const BACKGROUND_POLL_JOB = "background-task-poll";
/** The daily prune of finished background tasks older than `tools.outputRetentionDays`. */
export const BACKGROUND_PRUNE_JOB = "background-task-prune";

/** The time limit of one sandbox's poll exec. */
const POLL_EXEC_TIMEOUT_MS = 30_000;
/** The most output one poll exec keeps (a line per task, with a tail when it ended). */
const POLL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** What the poll exec reports for one task. */
export interface TaskReport {
  /** The exit file's code; null while there is none. */
  exitCode: number | null;
  /** Whether `pgrep -s <sid>` found a process. */
  alive: boolean;
  /** The last lines (decoded), read when the task exited or no process was left. */
  lastLines: string;
}

/**
 * The poll exec of one sandbox: for every task one line `<id> <exit code or -> <1|0> <tail or ->`.
 * Liveness is asked before the exit file: a task ending in between is seen by its exit file, never
 * as a task without process and exit file. The tail (base64) is read only for a task that exited
 * or has no process left. Relative to `/workspace`.
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

/** How a polled task ends, or null while it runs (spec §4.3). */
export function polledAs(
  task: BackgroundTaskRow,
  r: TaskReport,
  now: Date,
): BackgroundFinish | null {
  if (r.exitCode !== null) return exitedAs(task, r.exitCode, now);
  if (r.alive) return null;
  return { status: "lost", lostReason: "process_gone", killPending: false };
}

/**
 * The worker's background task jobs (spec 2026-11-05-background-bash-design §4.3), each once per
 * tick across replicas:
 * - `background-task-poll` (every `sandbox.background.pollSeconds`): for every sandbox with
 *   running tasks, one exec through `SandboxService.ifRunning` (which never creates or resumes a
 *   sandbox) reports each task's exit file and liveness; ended tasks finish through
 *   {@link BackgroundTaskFinisher}. Each poll takes and releases a lease, so `last_used_at` stays
 *   fresh and a sandbox with running tasks is never idle-suspended;
 * - `background-task-prune` (daily): deletes finished tasks older than `tools.outputRetentionDays`.
 */
@Injectable()
export class BackgroundTaskPollJob {
  constructor(
    @Inject(BackgroundTaskStore)
    private readonly store: Pick<BackgroundTaskStore, "runningStarted" | "pruneFinished">,
    @Inject(BackgroundTaskFinisher) private readonly finisher: BackgroundTaskFinisher,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "available" | "ifRunning">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(BACKGROUND_POLL_JOB, (cfg) => cfg.sandbox.background.pollSeconds * 1000)
  async poll(signal?: AbortSignal): Promise<void> {
    await this.pollOnce(signal);
  }

  /**
   * One poll of every running task (the body of {@link poll}); returns how many tasks finished.
   * A sandbox whose poll fails (busy, a provider error) is logged and tried again next tick.
   */
  async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<number> {
    if (!this.sandbox.available) return 0;
    const groups = new Map<string, BackgroundTaskRow[]>();
    for (const t of await this.store.runningStarted()) {
      if (t.sid === null || t.sandboxCreatedAt === null) continue;
      const key = `${t.sandboxConversationId} ${t.sandboxCreatedAt.getTime()}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    let finished = 0;
    for (const tasks of groups.values()) {
      if (signal.aborted) break;
      try {
        finished += await this.pollSandbox(tasks, signal);
      } catch (err) {
        if (signal.aborted) break;
        this.log.warn("cannot poll background tasks; retrying next tick", {
          conversationId: tasks[0]?.sandboxConversationId,
          err,
        });
      }
    }
    if (finished > 0) this.log.info("background tasks finished", { count: finished });
    return finished;
  }

  /** Polls the tasks of one sandbox instance; returns how many finished. */
  private async pollSandbox(tasks: BackgroundTaskRow[], signal: AbortSignal): Promise<number> {
    const [first] = tasks as [BackgroundTaskRow];
    const r = await this.sandbox.ifRunning(
      first.sandboxConversationId,
      { createdAt: first.sandboxCreatedAt as Date },
      async (p, h, sig) => {
        const res = await p.exec(h, {
          command: pollScript(tasks.map((t) => ({ id: t.id, sid: t.sid as string }))),
          cwd: "/workspace",
          timeoutMs: POLL_EXEC_TIMEOUT_MS,
          maxOutputBytes: POLL_MAX_OUTPUT_BYTES,
          signal: sig,
        });
        if (res.exitCode !== 0 || res.truncated) {
          throw new Error(
            `the poll exec failed (exit ${res.exitCode}${res.truncated ? ", truncated" : ""}): ${res.stderr.slice(0, 500)}`,
          );
        }
        return parsePollOutput(res.stdout);
      },
      signal,
    );
    const now = new Date();
    let n = 0;
    for (const t of tasks) {
      let to: BackgroundFinish | null;
      let lastLines = "";
      if (r.kind === "ran") {
        const report = r.value.get(t.id);
        // a task the exec did not report is checked again next tick
        to = report ? polledAs(t, report, now) : null;
        lastLines = report?.lastLines ?? "";
      } else if (r.kind === "not_running") {
        // a suspended sandbox may keep the processes (E2B's pause): killed after its next resume
        to = notRunningAs(r.status, r.status === "suspended");
      } else {
        to = RECREATED;
      }
      if (to && (await this.finisher.finish(t, to, lastLines, false))) n++;
    }
    return n;
  }

  /** Deletes the finished tasks older than `tools.outputRetentionDays` (their rows only). */
  @LockedCron("30 3 * * *", { name: BACKGROUND_PRUNE_JOB })
  async prune(): Promise<void> {
    const days = this.config.get().tools.outputRetentionDays;
    const n = await this.store.pruneFinished(new Date(Date.now() - days * 86_400_000));
    if (n > 0) this.log.info("finished background tasks pruned", { count: n });
  }
}
