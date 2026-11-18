import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  type IfRunningResult,
  retirementPending,
  SandboxService,
} from "../sandbox/sandbox.service.js";
import {
  type BackgroundFinish,
  type BackgroundStoppedBy,
  BackgroundTaskFinisher,
} from "./finish.js";
import {
  exactRefOf,
  lastLinesByRef,
  MANAGED_STOP_GRACE_MS,
  onManagedInstance,
  stopEnd,
  summaryLines,
} from "./managed.js";
import {
  type BackgroundTaskRow,
  BackgroundTaskStore,
  type CancelRequester,
  isManagedTask,
} from "./store.js";

/**
 * Why a task is stopped. `revoked`: the cancellation a revocation owes (its finish may wake the
 * conversation, unless a stop asked for it before: that asker's rule holds).
 */
export type StopReason = "tool" | "person" | "subagent_end" | "conversation_deleted" | "revoked";

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
 * Stops background tasks (spec 2026-11-05-background-bash-design §2.3, §4.3, permission runtime
 * cutover phase 8.3): a managed task by its exact ref on its exact instance only, through
 * `SandboxService.ifRunning` (it never creates or resumes a sandbox). A legacy (SID) task is never
 * signalled: while its instance runs it belongs to the retirement gate (`RetireLegacyTasksJob`),
 * and its stop is refused with that gate's actionable refusal; once its instance is gone or
 * replaced it finishes `lost` without any exec or signal.
 */
@Injectable()
export class BackgroundTaskStopper {
  constructor(
    @Inject(BackgroundTaskStore)
    private readonly store: Pick<
      BackgroundTaskStore,
      | "get"
      | "runningOwnedBy"
      | "runningIn"
      | "claimStop"
      | "releaseStop"
      | "requestCancel"
      | "noteCancelAttempt"
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
   * The stop first claims the task (`stopping_at`), so the poller leaves it alone while the stop
   * takes effect and the stop's finish is its only one. A legacy reservation that never started
   * (no instance) is only claimed: the poller fails it as abandoned. When the stop fails while the
   * sandbox runs (busy, a provider error, a legacy task's retirement refusal), the claim is given
   * up, the task stays `running` and the error is thrown. `how.reported`: the caller's own result
   * tells the model this finish (a managed task's cancellation settled from a TaskOutput read).
   */
  async stop(
    task: BackgroundTaskRow,
    why: StopReason,
    signal?: AbortSignal,
    how: { reported?: boolean } = {},
  ): Promise<BackgroundTaskRow> {
    if (!(await this.store.claimStop(task.id))) return (await this.store.get(task.id)) ?? task;
    // read after the claim: an acknowledgement recording the ref before the claim is seen here,
    // one recording it after sees the claim (both are single-row updates of the same row)
    const cur = (await this.store.get(task.id)) ?? task;
    if (isManagedTask(cur)) return this.stopManaged(cur, why, signal, how.reported);
    if (cur.status !== "running" || cur.sandboxCreatedAt === null) return cur;
    const started = { ...cur, sandboxCreatedAt: cur.sandboxCreatedAt };
    const reported = why === "tool";
    // a person's stop never wakes the conversation (background Bash §3, fix round 1), nor does
    // the stop of a conversation being deleted or of a sub-agent that ended (agent map spec §5.3)
    const stoppedBy: BackgroundStoppedBy | undefined =
      why === "person"
        ? "person"
        : why === "conversation_deleted"
          ? "deletion"
          : why === "subagent_end"
            ? "subagent_end"
            : undefined;
    const opts = stoppedBy === undefined ? {} : { stoppedBy };
    let r: IfRunningResult<never>;
    try {
      r = await this.legacyInstance(started, signal);
    } catch (err) {
      await this.store
        .releaseStop(cur.id)
        .catch((e: unknown) =>
          this.log.warn("cannot release a background task stop", { taskId: cur.id, err: e }),
        );
      throw err;
    }
    if (r.kind === "not_running") {
      await this.finisher.finish(cur, notRunningAs(r.status, true), "", reported, opts);
    } else if (r.kind === "other_instance") {
      await this.finisher.finish(cur, RECREATED, "", reported, opts);
    }
    return (await this.store.get(cur.id)) ?? cur;
  }

  /**
   * A managed task's stop (permission runtime cutover phase 8.3), claimed by {@link stop}: by its
   * exact ref on its exact instance only, with the five-second grace. The provider's atomically
   * claimed outcome decides the finish: `already-exited` keeps the natural exit, `stopped` is
   * stopped, `lost` is lost (the uncertainty retained), `cancel-pending` writes no finish (the
   * task stays running `cancel-pending`, the claim released, so the poller owes the exact stop
   * again). A task without its ref yet keeps the claim: its dispatch binding settles it unlaunched,
   * or its acknowledgement attaches the ref to an owed cancellation. An instance that is not
   * running (never resumed) or was replaced leaves the cancellation owed. Who asked is recorded,
   * so a later finish keeps their wake rule.
   */
  /**
   * `conversation_deleted` when the task's conversation, its tree's root (the device's
   * conversation, a sub-agent's root) or its org is deleted or gone, else null.
   */
  private async deletedConversationStop(cur: BackgroundTaskRow): Promise<CancelRequester | null> {
    const ids = [...new Set([cur.conversationId, cur.sandboxConversationId])];
    const [conversations, org] = await Promise.all([
      this.db.db
        .selectFrom("conversations")
        .select(["id", "deleted_at"])
        .where("id", "in", ids)
        .execute(),
      this.db.db
        .selectFrom("orgs")
        .select("deleted_at")
        .where("id", "=", cur.orgId)
        .executeTakeFirst(),
    ]);
    const live = conversations.filter((c) => c.deleted_at === null).length;
    return live < ids.length || org === undefined || org.deleted_at !== null
      ? "conversation_deleted"
      : null;
  }

  private async stopManaged(
    cur: BackgroundTaskRow,
    why: StopReason,
    signal: AbortSignal | undefined,
    reportedHere: boolean | undefined,
  ): Promise<BackgroundTaskRow> {
    if (cur.status !== "running") return cur;
    const asker: CancelRequester | null = why === "revoked" ? null : why;
    // the first asker's wake rule holds for the finish, whoever applies the stop; a revocation
    // that wins the race against its conversation's deletion stop is still the deletion's (its
    // finish must never wake anything)
    const by = cur.cancelRequestedBy ?? asker ?? (await this.deletedConversationStop(cur));
    if (cur.executionRef === null) {
      if (asker !== null) await this.store.requestCancel(cur.id, asker, false);
      return (await this.store.get(cur.id)) ?? cur;
    }
    // `reportedHere`: the caller's own result tells the model this finish (a TaskOutput read)
    const reported = reportedHere ?? (by === "tool" && why === "tool");
    const stoppedBy: BackgroundStoppedBy | undefined =
      by === "person"
        ? "person"
        : by === "conversation_deleted"
          ? "deletion"
          : by === "subagent_end"
            ? "subagent_end"
            : undefined;
    const opts = stoppedBy === undefined ? {} : { stoppedBy };
    const pending = async () => {
      await this.store.requestCancel(cur.id, asker, true);
      return (await this.store.get(cur.id)) ?? cur;
    };
    let r: IfRunningResult<{ to: BackgroundFinish | null; lastLines: string }>;
    try {
      exactRefOf(cur);
      await this.store.noteCancelAttempt(cur.id);
      r = await onManagedInstance(
        this.sandbox.ifRunning.bind(this.sandbox),
        cur,
        async (bg, h, ref, sig) => {
          const to = stopEnd(
            await bg.stop(h, ref, { graceMs: MANAGED_STOP_GRACE_MS, signal: sig }),
          );
          // once the provider claimed the outcome it stands: a failed tail only loses the lines
          const lines = to === null ? "" : summaryLines(await lastLinesByRef(bg, h, ref, sig));
          return { to, lastLines: lines };
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
      if (r.value.to === null) return pending();
      await this.finisher.finish(cur, r.value.to, r.value.lastLines, reported, opts);
    } else if (r.kind === "not_running") {
      // never resumed for a stop: a suspended instance keeps the cancellation owed; a missing or
      // destroyed one is lost like an acknowledged task's (the uncertain record is retained)
      if (r.status === "suspended") return pending();
      await this.finisher.finish(cur, notRunningAs(r.status, false), "", reported, opts);
    } else {
      await this.finisher.finish(cur, RECREATED, "", reported, opts);
    }
    return (await this.store.get(cur.id)) ?? cur;
  }

  /**
   * A legacy task's own instance, never signalled: a running one refuses with the retirement
   * gate's refusal before any provider call (the gate retires it and its processes whole); one
   * that is not running or was replaced is reported, so the task finishes without any exec or
   * signal. A task from before devices has none.
   */
  private async legacyInstance(
    cur: BackgroundTaskRow & { sandboxCreatedAt: Date },
    signal: AbortSignal | undefined,
  ): Promise<IfRunningResult<never>> {
    if (cur.deviceId === null) return { kind: "not_running", status: "gone" };
    return this.sandbox.ifRunning(
      cur.deviceId,
      { createdAt: cur.sandboxCreatedAt },
      async () => {
        throw retirementPending();
      },
      signal,
    );
  }

  /**
   * After a sub-agent run ended (spec §4.3): stops the running tasks of `conversationId` when it
   * is a sub-agent's conversation; any other conversation is left alone. With `runId`, only the
   * tasks that run started (a fork child's run: a later run of the same child keeps its own when
   * an older run's end is handled late); without, all of them (a stopped background child, agent
   * map spec §6). Their finish is marked `stoppedBy: "subagent_end"`, so it never wakes the child.
   * Never throws (see {@link stopAll}).
   */
  async stopSubagentTasks(conversationId: string, runId?: string): Promise<void> {
    try {
      const conv = await this.db
        .selectFrom("conversations")
        .select("kind")
        .where("id", "=", conversationId)
        .executeTakeFirst();
      if (conv?.kind !== "subagent") return;
      const tasks = (await this.store.runningOwnedBy(conversationId)).filter(
        (t) => runId === undefined || t.runId === runId,
      );
      await this.stopAll(tasks, "subagent_end");
    } catch (err) {
      this.log.warn("cannot stop the background tasks of a finished sub-agent run", {
        conversationId,
        runId,
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
   * (logged): a managed task stays owed to the poller and ends at its own deadline at the latest;
   * a legacy task stays with the retirement gate until its instance is destroyed or quarantined
   * (no deadline ends it in the kernel's view).
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
