import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type IfRunningResult, SandboxService } from "../sandbox/sandbox.service.js";
import { type BackgroundFinish, BackgroundTaskFinisher } from "./finish.js";
import { TASKS_DIR } from "./launch.js";
import { assertTaskRef, decodeTail, killSession, tailCommand } from "./session.js";
import { type BackgroundTaskRow, BackgroundTaskStore } from "./store.js";

/** Why a task is stopped. */
export type StopReason = "tool" | "person" | "subagent_end" | "conversation_deleted";

/** How long a stop waits after SIGTERM before SIGKILL (spec §2.3). */
export const STOP_GRACE_MS = 5000;

/** The time limit of the SIGTERM exec: the grace period plus some room. */
const TERM_EXEC_TIMEOUT_MS = STOP_GRACE_MS + 5000;
/** The time limit of reading the last lines after a stop. */
const TAIL_EXEC_TIMEOUT_MS = 10_000;

/**
 * Exit code 0 with `exited <code>` when the task had already finished (its exit file exists),
 * else sends SIGTERM to the session and waits up to {@link STOP_GRACE_MS} for it to empty, then
 * prints `term`. Relative to `/workspace`.
 */
function termScript(id: string, sid: string): string {
  const f = `${TASKS_DIR}/${id}`;
  const tries = Math.ceil(STOP_GRACE_MS / 200);
  return [
    `if [ -s ${f}.exit ]; then echo "exited $(cat ${f}.exit)"; exit 0; fi`,
    `pkill -TERM -s ${sid} >/dev/null 2>&1`,
    `i=0; while [ "$i" -lt ${tries} ] && pgrep -s ${sid} >/dev/null 2>&1; do sleep 0.2; i=$((i+1)); done`,
    "echo term",
  ].join("\n");
}

/** How a task that exited by itself ends (spec §4.3): exit 137 past its deadline timed out. */
export function exitedAs(task: BackgroundTaskRow, code: number, now: Date): BackgroundFinish {
  if (code === 0) return { status: "completed", exitCode: 0 };
  if (code === 137 && now.getTime() >= task.deadlineAt.getTime()) {
    return { status: "timed_out", exitCode: 137 };
  }
  return { status: "failed", exitCode: code };
}

/** How a task whose sandbox is not running ends (`ifRunning`'s `not_running` status). */
export function notRunningAs(status: string, killPending: boolean): BackgroundFinish {
  return {
    status: "lost",
    lostReason: status === "suspended" ? "sandbox_suspended" : "sandbox_gone",
    killPending,
  };
}

/** A task found in another sandbox instance (a rebuild): its processes are gone with the old one. */
export const RECREATED: BackgroundFinish = {
  status: "lost",
  lostReason: "sandbox_recreated",
  killPending: false,
};

/**
 * Stops background tasks (spec 2026-11-05-background-bash-design §2.3, §4.3): SIGTERM to the
 * task's session, up to 5 s for it to empty, then SIGKILL until it is empty, all through
 * `SandboxService.ifRunning` (it never creates or resumes a sandbox); the task then finishes as
 * `stopped` with its last 20 lines. A task that had already exited finishes as its exit says. When
 * the sandbox is not running the task finishes as `lost` with `kill_pending` (killed right after a
 * resume); in a rebuilt sandbox as `lost` (`sandbox_recreated`).
 */
@Injectable()
export class BackgroundTaskStopper {
  constructor(
    @Inject(BackgroundTaskStore)
    private readonly store: Pick<
      BackgroundTaskStore,
      "get" | "runningOwnedBy" | "runningIn" | "claimStop" | "releaseStop"
    >,
    @Inject(BackgroundTaskFinisher) private readonly finisher: BackgroundTaskFinisher,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "ifRunning">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Stops `task` and returns its row afterwards. A task that is no longer running, or that another
   * live stop already claimed, is returned as it is now.
   *
   * The stop first claims the task (`stopping_at`), so the poller leaves it alone while the
   * signals take effect and the stop's finish is its only one. A reservation whose launch has not
   * started the command yet (no `sid`) is only claimed: the launch then kills what it starts and
   * finishes the row `stopped`. When the stop fails while the sandbox runs (busy, a provider
   * error, a session that could not be confirmed empty), the claim is given up, the task stays
   * `running` and the error is thrown.
   */
  async stop(
    task: BackgroundTaskRow,
    why: StopReason,
    signal?: AbortSignal,
  ): Promise<BackgroundTaskRow> {
    if (!(await this.store.claimStop(task.id))) return (await this.store.get(task.id)) ?? task;
    // read after the claim: a launch recording its session before the claim is seen here, one
    // recording it after sees the claim (both are single-row updates of the same row)
    const cur = (await this.store.get(task.id)) ?? task;
    if (cur.status !== "running" || cur.sid === null || cur.sandboxCreatedAt === null) return cur;
    const sid = cur.sid;
    assertTaskRef(cur.id, sid);
    const reported = why === "tool";
    // a person's stop never wakes the conversation (background Bash §3, fix round 1)
    const opts = why === "person" ? { stoppedBy: "person" as const } : {};
    let r: IfRunningResult<{ to: BackgroundFinish; lastLines: string }>;
    try {
      r = await this.sandbox.ifRunning(
        cur.sandboxConversationId,
        { createdAt: cur.sandboxCreatedAt },
        async (p, h, sig) => {
          const term = await p.exec(h, {
            command: termScript(cur.id, sid),
            cwd: "/workspace",
            timeoutMs: TERM_EXEC_TIMEOUT_MS,
            maxOutputBytes: 4096,
            signal: sig,
          });
          const exited = /^exited (-?[0-9]+)$/.exec(term.stdout.trim());
          if (term.exitCode !== 0 || (!exited && term.stdout.trim() !== "term")) {
            throw new Error(`the stop of background task ${cur.id} failed (${term.exitCode})`);
          }
          if (!exited && !(await killSession(p, h, sid))) {
            throw new Error(`background task ${cur.id} could not be confirmed stopped`);
          }
          const tail = await p.exec(h, {
            command: tailCommand(cur.id),
            cwd: "/workspace",
            timeoutMs: TAIL_EXEC_TIMEOUT_MS,
            maxOutputBytes: 64 * 1024,
            signal: sig,
          });
          const lastLines = tail.exitCode === 0 ? decodeTail(tail.stdout) : "";
          // a task that had exited before the signal ends as its exit says
          const to: BackgroundFinish = exited
            ? exitedAs(cur, Number(exited[1]), new Date())
            : { status: "stopped" };
          return { to, lastLines };
        },
        signal,
      );
    } catch (err) {
      await this.store
        .releaseStop(cur.id)
        .catch((e: unknown) =>
          this.log.warn("cannot release a background task stop", { taskId: cur.id, err: e }),
        );
      throw err;
    }
    if (r.kind === "ran") {
      await this.finisher.finish(cur, r.value.to, r.value.lastLines, reported, opts);
    } else if (r.kind === "not_running") {
      await this.finisher.finish(cur, notRunningAs(r.status, true), "", reported, opts);
    } else {
      await this.finisher.finish(cur, RECREATED, "", reported, opts);
    }
    return (await this.store.get(cur.id)) ?? cur;
  }

  /**
   * After a sub-agent's run ended (spec §4.3): stops the running tasks of `conversationId` when it
   * is a sub-agent's conversation (nobody can read or stop them through the child's model after
   * that); any other conversation is left alone. Never throws (see {@link stopAll}).
   */
  async stopSubagentTasks(conversationId: string): Promise<void> {
    try {
      const conv = await this.db
        .selectFrom("conversations")
        .select("kind")
        .where("id", "=", conversationId)
        .executeTakeFirst();
      if (conv?.kind !== "subagent") return;
      await this.stopAll(await this.store.runningOwnedBy(conversationId), "subagent_end");
    } catch (err) {
      this.log.warn("cannot stop the background tasks of a finished sub-agent run", {
        conversationId,
        err,
      });
    }
  }

  /**
   * Before a conversation is deleted: stops every running task in its sandbox (its own and its
   * sub-agents'). Never throws (see {@link stopAll}).
   */
  async stopForDeletedConversation(conversationId: string): Promise<void> {
    try {
      await this.stopAll(await this.store.runningIn(conversationId), "conversation_deleted");
    } catch (err) {
      this.log.warn("cannot stop the background tasks of a deleted conversation", {
        conversationId,
        err,
      });
    }
  }

  /**
   * Stops `tasks` side by side. A stop that fails while the sandbox runs leaves its task running
   * (logged): the poller still checks it and it ends at its own deadline at the latest.
   */
  private async stopAll(tasks: BackgroundTaskRow[], why: StopReason): Promise<void> {
    await Promise.all(
      tasks.map(async (t) => {
        try {
          await this.stop(t, why);
        } catch (err) {
          this.log.warn("cannot stop a background task; it keeps running", { taskId: t.id, err });
        }
      }),
    );
  }
}
