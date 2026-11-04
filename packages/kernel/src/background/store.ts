import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import { sql } from "kysely";
import type { BackgroundTasksTable } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { BackgroundLaunchLock } from "./launch-lock.js";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "lost";

/** A task as the kernel reads it: the columns of `capybara.background_tasks`, camel-cased. */
export interface BackgroundTaskRow {
  id: string;
  orgId: string;
  /** The owner: the child conversation for a sub-agent. */
  conversationId: string;
  /** The root conversation that owns the sandbox. */
  sandboxConversationId: string;
  runId: string;
  callId: string;
  triggerAccountId: string;
  description: string;
  command: string;
  /**
   * The session id (the pid `setsid` started). Null while the launch is reserved but has not
   * started: readers that act on the process (the poller, stops) skip such a row.
   */
  sid: string | null;
  /** Relative to `/workspace`. */
  outputPath: string;
  status: BackgroundTaskStatus;
  lostReason: string | null;
  exitCode: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  deadlineAt: Date;
  /** The sandbox instance the task started in; null while reserved, like `sid`. */
  sandboxCreatedAt: Date | null;
  /** Marked lost while its process may still exist. */
  killPending: boolean;
  /** The bytes `TaskOutput` has already returned. */
  readOffset: number;
  /** When a stop claimed the task ({@link BackgroundTaskStore.claimStop}); null otherwise. */
  stoppingAt: Date | null;
}

export type BackgroundTaskInsert = Omit<
  BackgroundTaskRow,
  "status" | "finishedAt" | "exitCode" | "lostReason" | "killPending" | "readOffset" | "stoppingAt"
>;

/** A launch's reservation: the row before the command started (no `sid`, no instance yet). */
export type BackgroundTaskReservation = Omit<BackgroundTaskInsert, "sid" | "sandboxCreatedAt">;

const toRow = (r: Selectable<BackgroundTasksTable>): BackgroundTaskRow => ({
  id: r.id,
  orgId: r.org_id,
  conversationId: r.conversation_id,
  sandboxConversationId: r.sandbox_conversation_id,
  runId: r.run_id,
  callId: r.call_id,
  triggerAccountId: r.trigger_account_id,
  description: r.description,
  command: r.command,
  sid: r.sid,
  outputPath: r.output_path,
  status: r.status,
  lostReason: r.lost_reason,
  exitCode: r.exit_code,
  startedAt: new Date(r.started_at),
  finishedAt: r.finished_at === null ? null : new Date(r.finished_at),
  deadlineAt: new Date(r.deadline_at),
  sandboxCreatedAt: r.sandbox_created_at === null ? null : new Date(r.sandbox_created_at),
  killPending: r.kill_pending,
  readOffset: Number(r.read_offset),
  stoppingAt: r.stopping_at === null ? null : new Date(r.stopping_at),
});

/**
 * How long a stop's claim holds: a claim older than this is abandoned (its stopper died), so the
 * poller checks the task again and another stop may claim it. Longer than any stop takes (the
 * lease wait, the SIGTERM grace, the kill and the tail).
 */
export const STOP_CLAIM_TTL_MS = 5 * 60_000;

/** A condition: the row is not claimed by a live stop. */
const unclaimed = sql<boolean>`(stopping_at IS NULL OR stopping_at < now() - ${STOP_CLAIM_TTL_MS}::integer * interval '1 millisecond')`;

/**
 * Background Bash tasks (spec §4.1): one `capybara.background_tasks` row per command started with
 * `run_in_background`. The store only reads and writes rows; the launch, the poller and the tools
 * that drive them are other providers.
 *
 * A launch first reserves its row ({@link BackgroundTaskStore.reserve}: `running`, `sid` null),
 * then starts the command and sets `sid` ({@link BackgroundTaskStore.markStarted}), or finishes
 * the row as `failed` ({@link BackgroundTaskStore.failLaunch}). A running row with a null `sid`
 * counts against `maxTasks` but has no process to check or stop: the poller and stops must skip
 * it (the launch that reserved it settles it; one left over by a launch that died is failed by the
 * poller, {@link BackgroundTaskStore.failAbandonedLaunches}).
 */
@Injectable()
export class BackgroundTaskStore {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(BackgroundLaunchLock) private readonly launchLock: BackgroundLaunchLock,
  ) {}

  /**
   * Reserves a launch: under the sandbox's launch lock, counts the running tasks of
   * `row.sandboxConversationId` and inserts `row` as `running` (no `sid`) when fewer than
   * `maxTasks` run. False (nothing written) when the sandbox already runs `maxTasks`.
   */
  @Transactional()
  async reserve(row: BackgroundTaskReservation, maxTasks: number): Promise<boolean> {
    await this.launchLock.lock(row.sandboxConversationId);
    if ((await this.countRunning(row.sandboxConversationId)) >= maxTasks) return false;
    await this.insert({ ...row, sid: null, sandboxCreatedAt: null });
    return true;
  }

  /**
   * Records the started command of a reserved row: `started`, or `stopping` when a stop claimed the
   * reservation meanwhile (the launch then kills the command and finishes the row with
   * {@link finishStoppedLaunch}); false when the row is no longer running.
   */
  async markStarted(
    id: string,
    to: { sid: string; sandboxCreatedAt: Date },
  ): Promise<"started" | "stopping" | false> {
    const r = await this.db
      .updateTable("background_tasks")
      .set({ sid: to.sid, sandbox_created_at: to.sandboxCreatedAt })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where("sid", "is", null)
      .returning("stopping_at")
      .executeTakeFirst();
    if (!r) return false;
    return r.stopping_at === null ? "started" : "stopping";
  }

  /**
   * Finishes a launch whose reservation a stop claimed, once the launch killed what it started:
   * `stopped`. No `background_task_finished` event: the launching call reports it itself.
   */
  async finishStoppedLaunch(id: string): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({ status: "stopped", finished_at: sql<Date>`now()`, stopping_at: null })
      .where("id", "=", id)
      .where("status", "=", "running")
      .execute();
  }

  /**
   * Claims a running task for a stop (`stopping_at`): false when it is no longer running or another
   * live stop claimed it ({@link STOP_CLAIM_TTL_MS}). While claimed the poller leaves it alone.
   */
  async claimStop(id: string): Promise<boolean> {
    const r = await this.db
      .updateTable("background_tasks")
      .set({ stopping_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where(unclaimed)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /** Gives up a stop's claim (the stop failed while the sandbox runs: the task keeps running). */
  async releaseStop(id: string): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({ stopping_at: null })
      .where("id", "=", id)
      .where("status", "=", "running")
      .execute();
  }

  /**
   * Finishes a reserved row whose launch failed as `failed`, with `reason` in `lost_reason` (and a
   * stop's claim cleared); a row that already has its sid (the command started and is tracked) is
   * left as it is. No `background_task_finished` event: the launching call reports the failure
   * itself.
   */
  async failLaunch(id: string, reason: string): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({
        status: "failed",
        finished_at: sql<Date>`now()`,
        lost_reason: reason,
        stopping_at: null,
      })
      .where("id", "=", id)
      .where("status", "=", "running")
      // only a reservation that never started: a row with its sid is tracked by the poller
      .where("sid", "is", null)
      .execute();
  }

  /**
   * Finishes as `failed` (`lost_reason` `launch_abandoned`) every reservation that started before
   * `before`, never got its sid and is not claimed by a live stop: the launch that reserved it died
   * (a crashed replica). A stop's claim older than {@link STOP_CLAIM_TTL_MS} does not hold it: a
   * stop only claims a reservation and leaves the rest to the launch, so a dead launch would keep
   * it (and its slot of `maxTasks`) forever. Conditional on `sid` still null, so a launch
   * completing at that moment wins. No `background_task_finished` event: the command never
   * started and the model never saw its id. Returns the rows it finished (their owner and sandbox
   * conversations, for the caller's `changed: "background"` frames).
   */
  async failAbandonedLaunches(
    before: Date,
  ): Promise<{ id: string; conversationId: string; sandboxConversationId: string }[]> {
    const r = await this.db
      .updateTable("background_tasks")
      .set({
        status: "failed",
        finished_at: sql<Date>`now()`,
        lost_reason: "launch_abandoned",
        stopping_at: null,
      })
      .where("status", "=", "running")
      .where("sid", "is", null)
      .where(unclaimed)
      .where("started_at", "<", before)
      .returning(["id", "conversation_id", "sandbox_conversation_id"])
      .execute();
    return r.map((x) => ({
      id: x.id,
      conversationId: x.conversation_id,
      sandboxConversationId: x.sandbox_conversation_id,
    }));
  }

  async insert(row: BackgroundTaskInsert): Promise<void> {
    await this.db
      .insertInto("background_tasks")
      .values({
        id: row.id,
        org_id: row.orgId,
        conversation_id: row.conversationId,
        sandbox_conversation_id: row.sandboxConversationId,
        run_id: row.runId,
        call_id: row.callId,
        trigger_account_id: row.triggerAccountId,
        description: row.description,
        command: row.command,
        sid: row.sid,
        output_path: row.outputPath,
        started_at: row.startedAt,
        deadline_at: row.deadlineAt,
        sandbox_created_at: row.sandboxCreatedAt,
      })
      .execute();
  }

  async get(id: string): Promise<BackgroundTaskRow | undefined> {
    const r = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return r === undefined ? undefined : toRow(r);
  }

  /** The running tasks of one sandbox, oldest first. */
  async runningIn(sandboxConversationId: string): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("sandbox_conversation_id", "=", sandboxConversationId)
      .where("status", "=", "running")
      .orderBy("started_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toRow);
  }

  /**
   * Every running task that has started (its `sid` is set) and no live stop claimed, across
   * sandboxes, oldest first: what the poller checks. A reservation still launching (`sid` null) is
   * left to its launch, a claimed task to its stop.
   */
  async runningStarted(): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("status", "=", "running")
      .where("sid", "is not", null)
      .where(unclaimed)
      .orderBy("started_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toRow);
  }

  /** The running tasks one conversation owns (not those of its sub-agents), oldest first. */
  async runningOwnedBy(conversationId: string): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("status", "=", "running")
      .orderBy("started_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toRow);
  }

  async countRunning(sandboxConversationId: string): Promise<number> {
    const r = await this.db
      .selectFrom("background_tasks")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("sandbox_conversation_id", "=", sandboxConversationId)
      .where("status", "=", "running")
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** The tasks owned by any of the conversations, newest first. */
  async listFor(conversationIds: string[]): Promise<BackgroundTaskRow[]> {
    if (conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("conversation_id", "in", conversationIds)
      .orderBy("started_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return rows.map(toRow);
  }

  /**
   * Conditional `running` to a final status; false when the row was no longer running (another
   * path finished it first), or, with `opts.unclaimed` (the poller), when a live stop claimed it.
   * The caller's transaction also appends the finished event.
   */
  @Transactional({ propagation: "mandatory" })
  async finish(
    id: string,
    to: {
      status: Exclude<BackgroundTaskStatus, "running">;
      exitCode?: number | null;
      lostReason?: string;
      killPending?: boolean;
    },
    opts: { unclaimed?: boolean } = {},
  ): Promise<boolean> {
    let q = this.db
      .updateTable("background_tasks")
      .set({
        status: to.status,
        finished_at: sql<Date>`now()`,
        exit_code: to.exitCode ?? null,
        lost_reason: to.lostReason ?? null,
        stopping_at: null,
        ...(to.killPending !== undefined && { kill_pending: to.killPending }),
      })
      .where("id", "=", id)
      .where("status", "=", "running");
    if (opts.unclaimed) q = q.where(unclaimed);
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /** Moves the read offset forward only (a concurrent reader never moves it back). */
  async advanceOffset(id: string, to: number): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({ read_offset: to })
      .where("id", "=", id)
      .where(sql<boolean>`read_offset < ${to}`)
      .execute();
  }

  /** Finished tasks of a sandbox whose process may still exist. */
  async pendingKills(sandboxConversationId: string): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("sandbox_conversation_id", "=", sandboxConversationId)
      .where("kill_pending", "=", true)
      .orderBy("started_at", "asc")
      .execute();
    return rows.map(toRow);
  }

  async clearKill(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable("background_tasks")
      .set({ kill_pending: false })
      .where("id", "in", ids)
      .execute();
  }

  /** Deletes finished tasks that ended before `before`; a running one is never deleted. */
  async pruneFinished(before: Date): Promise<number> {
    const r = await this.db
      .deleteFrom("background_tasks")
      .where("status", "<>", "running")
      .where("finished_at", "<", before)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }
}
