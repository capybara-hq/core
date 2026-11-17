import type { SandboxExecutionRef } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import { sql } from "kysely";
import type { BackgroundLaunchState, BackgroundTasksTable } from "../db/kernel-schema.js";
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
  /**
   * The root conversation of the owner's tree: `sandbox.background.maxTasks` counts per root
   * conversation.
   */
  sandboxConversationId: string;
  /**
   * The device the task runs in (the root conversation's when it was launched): its instance
   * is where the task's processes are. Null only for tasks from before devices (all finished).
   */
  deviceId: string | null;
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
  /**
   * The output file: absolute once the task started (`markStarted` records it under its
   * instance's workspace root), relative to the workspace root while reserved
   * (`taskOutputFile` in launch.ts).
   */
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
  /** `legacy` for SID-launched rows; a managed launch's durable state otherwise (0143). */
  launchState: BackgroundLaunchState;
  /** A managed task's stable start operation (null for legacy rows). */
  operationId: string | null;
  /** A managed task's trusted working root, persisted before dispatch. */
  workingRoot: string | null;
  /** A managed task's output retention deadline, part of its start input. */
  retainUntil: Date | null;
  /** The exact typed start result; never inferred from a SID, PID or path. */
  executionRef: SandboxExecutionRef | null;
  /** A managed task's held instance (its handle id), bound at dispatch. */
  instanceId: string | null;
  /** A managed task's exact instance generation (its `created_at` in ms), bound at dispatch. */
  instanceGeneration: string | null;
  /** When a managed task's cancellation was asked for (a stop or a revocation). */
  cancelRequestedAt: Date | null;
  /** Who asked for it by a stop (0144); null for a revocation's cancellation or none. */
  cancelRequestedBy: CancelRequester | null;
}

/** Who asked for a managed task's stop: their wake rule holds for its later finish. */
export type CancelRequester = "tool" | "person" | "conversation_deleted" | "subagent_end";

/** Whether `task` is a managed (exact-ref) task rather than a legacy SID one. */
export const isManagedTask = (task: Pick<BackgroundTaskRow, "launchState">): boolean =>
  task.launchState !== "legacy";

/** A managed launch's reservation: everything known before the start is dispatched. */
export interface ManagedTaskReservation {
  id: string;
  orgId: string;
  conversationId: string;
  sandboxConversationId: string;
  deviceId: string;
  runId: string;
  callId: string;
  triggerAccountId: string;
  description: string;
  command: string;
  operationId: string;
  workingRoot: string;
  /** Absolute: `${workingRoot}/.capybara/tasks/${id}.out`. */
  outputPath: string;
  startedAt: Date;
  deadlineAt: Date;
  retainUntil: Date;
}

/** {@link BackgroundTaskStore.reserveManaged}'s answer. */
export type ManagedReservation =
  | { kind: "reserved"; row: BackgroundTaskRow }
  /** The same run call reserved before (a retry): its persisted identity is reused as it is. */
  | { kind: "existing"; row: BackgroundTaskRow }
  | { kind: "full" };

export type BackgroundTaskInsert = Omit<
  BackgroundTaskRow,
  | "status"
  | "finishedAt"
  | "exitCode"
  | "lostReason"
  | "killPending"
  | "readOffset"
  | "stoppingAt"
  | "launchState"
  | "operationId"
  | "workingRoot"
  | "retainUntil"
  | "executionRef"
  | "instanceId"
  | "instanceGeneration"
  | "cancelRequestedAt"
  | "cancelRequestedBy"
>;

/** A launch's reservation: the row before the command started (no `sid`, no instance yet). */
export type BackgroundTaskReservation = Omit<BackgroundTaskInsert, "sid" | "sandboxCreatedAt">;

const toRow = (r: Selectable<BackgroundTasksTable>): BackgroundTaskRow => ({
  id: r.id,
  orgId: r.org_id,
  conversationId: r.conversation_id,
  sandboxConversationId: r.sandbox_conversation_id,
  deviceId: r.device_id,
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
  launchState: r.launch_state,
  operationId: r.operation_id,
  workingRoot: r.working_root,
  retainUntil: r.retain_until === null ? null : new Date(r.retain_until),
  executionRef: r.execution_ref,
  instanceId: r.instance_id,
  instanceGeneration: r.instance_generation,
  cancelRequestedAt: r.cancel_requested_at === null ? null : new Date(r.cancel_requested_at),
  cancelRequestedBy: r.cancel_requested_by,
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
   * Reserves a launch: under the root conversation's launch lock, counts the running tasks of
   * `row.sandboxConversationId` and inserts `row` as `running` (no `sid`) when fewer than
   * `maxTasks` run. False (nothing written) when that conversation tree already runs `maxTasks`.
   */
  @Transactional()
  async reserve(row: BackgroundTaskReservation, maxTasks: number): Promise<boolean> {
    await this.launchLock.lock(row.sandboxConversationId);
    if ((await this.countRunning(row.sandboxConversationId)) >= maxTasks) return false;
    // not admitted for dispatch yet (0148): the launch's freeze check marks it `dispatched`
    await this.insert({ ...row, sid: null, sandboxCreatedAt: null }, "reserved");
    return true;
  }

  /**
   * Reserves a managed launch (permission runtime cutover phase 8.2) under the root conversation's
   * launch lock, before anything is dispatched: the task id, its stable operation id, the
   * working root, the absolute artifact path, the deadline and the retention deadline. A retry of
   * the same run call (same `runId` / `callId`) gets the row it reserved before, unchanged, so the
   * start input and its hash stay the same; it never takes a second slot of `maxTasks`.
   */
  @Transactional()
  async reserveManaged(row: ManagedTaskReservation, maxTasks: number): Promise<ManagedReservation> {
    await this.launchLock.lock(row.sandboxConversationId);
    const previous = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("run_id", "=", row.runId)
      .where("call_id", "=", row.callId)
      .where("launch_state", "<>", "legacy")
      .executeTakeFirst();
    if (previous) return { kind: "existing", row: toRow(previous) };
    if ((await this.countRunning(row.sandboxConversationId)) >= maxTasks) return { kind: "full" };
    const inserted = await this.db
      .insertInto("background_tasks")
      .values({
        id: row.id,
        org_id: row.orgId,
        conversation_id: row.conversationId,
        sandbox_conversation_id: row.sandboxConversationId,
        device_id: row.deviceId,
        run_id: row.runId,
        call_id: row.callId,
        trigger_account_id: row.triggerAccountId,
        description: row.description,
        command: row.command,
        sid: null,
        output_path: row.outputPath,
        started_at: row.startedAt,
        deadline_at: row.deadlineAt,
        sandbox_created_at: null,
        launch_state: "pending",
        operation_id: row.operationId,
        working_root: row.workingRoot,
        retain_until: row.retainUntil,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: "reserved", row: toRow(inserted) };
  }

  /**
   * Fails a managed reservation that provably never dispatched (`pending`): `failed`, `terminal`,
   * when `executionId` is still the run's current execution claim.
   * A dispatched row is never failed here: a null reference is no proof that nothing launched.
   */
  async failManagedPreEffect(id: string, reason: string, executionId: string): Promise<boolean> {
    const r = await this.db
      .updateTable("background_tasks")
      .set({
        status: "failed",
        launch_state: "terminal",
        finished_at: sql<Date>`now()`,
        lost_reason: reason,
        stopping_at: null,
      })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where("launch_state", "=", "pending")
      // only the run's current execution claim settles it: a stale one never fails the retry
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("runs")
            .select("runs.id")
            .whereRef("runs.id", "=", "background_tasks.run_id")
            .where("runs.execution_id", "=", executionId),
        ),
      )
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /**
   * Records the started command of a reserved row: `started`, or `stopping` when a stop claimed the
   * reservation meanwhile (the launch then kills the command and finishes the row with
   * {@link finishStoppedLaunch}); false when the row is no longer running.
   */
  async markStarted(
    id: string,
    to: { sid: string; sandboxCreatedAt: Date; outputPath?: string },
  ): Promise<"started" | "stopping" | false> {
    const r = await this.db
      .updateTable("background_tasks")
      .set({
        sid: to.sid,
        sandbox_created_at: to.sandboxCreatedAt,
        ...(to.outputPath !== undefined && { output_path: to.outputPath }),
      })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where("sid", "is", null)
      .where("launch_state", "=", "legacy")
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
      // a managed row settles through its durable launch state only
      .where("launch_state", "=", "legacy")
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
        // a managed reservation that never dispatched settles; dispatch is conditional on
        // `pending`, so a launch racing this update either wins or is refused before effects
        launch_state: sql<BackgroundLaunchState>`CASE WHEN launch_state = 'pending' THEN 'terminal' ELSE launch_state END`,
      })
      .where("status", "=", "running")
      .where("sid", "is", null)
      // never a dispatched, acknowledged or cancel-pending managed task
      .where("launch_state", "in", ["legacy", "pending"])
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

  /**
   * Inserts a legacy row. `legacyDispatch` (0148) defaults to `unknown`: a row is "never
   * dispatched" only when its reservation says so.
   */
  async insert(
    row: BackgroundTaskInsert,
    legacyDispatch: "unknown" | "reserved" = "unknown",
  ): Promise<void> {
    await this.db
      .insertInto("background_tasks")
      .values({
        legacy_dispatch: legacyDispatch,
        id: row.id,
        org_id: row.orgId,
        conversation_id: row.conversationId,
        sandbox_conversation_id: row.sandboxConversationId,
        device_id: row.deviceId,
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

  /** The managed task launched by start operation `operationId`, if its row still exists. */
  async byOperation(operationId: string): Promise<BackgroundTaskRow | undefined> {
    const r = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("operation_id", "=", operationId)
      .executeTakeFirst();
    return r === undefined ? undefined : toRow(r);
  }

  /**
   * A finished managed task whose owed cancellation was later established by its exact ref (the
   * revoke worker): its record becomes `terminal`. Its finish and event stay as they were.
   */
  async settleOwedCancel(id: string): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({ launch_state: "terminal" })
      .where("id", "=", id)
      .where("status", "<>", "running")
      .where("launch_state", "=", "cancel-pending")
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

  /** The running tasks of one root conversation's tree, oldest first. */
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

  /**
   * Every running acknowledged managed task with no live stop claim, oldest first: what the
   * poller checks by exact status.
   */
  async runningManaged(): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("status", "=", "running")
      .where("launch_state", "=", "acknowledged")
      .where("execution_ref", "is not", null)
      .where(unclaimed)
      .orderBy("started_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toRow);
  }

  /**
   * The running managed tasks that owe an exact stop (`cancel-pending` with a ref, no live stop
   * claim), least recently attempted first. A task whose recorded instance is suspended is left
   * out: a stop never resumes it, so it cannot progress there.
   */
  async owedCancels(): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll("background_tasks")
      .leftJoin("device_instances", "device_instances.device_id", "background_tasks.device_id")
      .where("background_tasks.status", "=", "running")
      .where("background_tasks.launch_state", "=", "cancel-pending")
      .where("background_tasks.execution_ref", "is not", null)
      .where(
        sql<boolean>`(background_tasks.stopping_at IS NULL OR background_tasks.stopping_at < now() - ${STOP_CLAIM_TTL_MS}::integer * interval '1 millisecond')`,
      )
      .where(
        sql<boolean>`NOT (device_instances.status IS NOT DISTINCT FROM 'suspended' AND floor(extract(epoch from device_instances.created_at) * 1000)::bigint::text = background_tasks.instance_generation)`,
      )
      .orderBy(sql`background_tasks.cancel_attempted_at ASC NULLS FIRST`)
      .orderBy("background_tasks.started_at", "asc")
      .orderBy("background_tasks.id", "asc")
      .execute();
    return rows.map(toRow);
  }

  /** Records that an exact stop of the task is being attempted now (its owed-stop turn moves back). */
  async noteCancelAttempt(id: string): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({ cancel_attempted_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Records who asked for a running managed task's stop (the first asker is kept) and when. With
   * `release` (the stop could not settle now: the provider recorded a pending cancellation, or the
   * instance is not reachable) an acknowledged task becomes `cancel-pending` and the stop's claim
   * is given up, so the poller owes the exact stop; without, the claim stays (a task without its
   * ref yet: the dispatch binding or the acknowledgement turns the claim into the owed cancel).
   */
  async requestCancel(id: string, by: CancelRequester | null, release: boolean): Promise<void> {
    await this.db
      .updateTable("background_tasks")
      .set({
        cancel_requested_by: sql<CancelRequester | null>`COALESCE(cancel_requested_by, ${by}::text)`,
        cancel_requested_at: sql<Date>`COALESCE(cancel_requested_at, now())`,
        ...(release && {
          stopping_at: null,
          launch_state: sql<BackgroundLaunchState>`CASE WHEN launch_state = 'acknowledged' THEN 'cancel-pending' ELSE launch_state END`,
        }),
      })
      .where("id", "=", id)
      .where("status", "=", "running")
      .where("launch_state", "<>", "legacy")
      .execute();
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

  /**
   * The finished tasks one conversation owns (not those of its sub-agents), the most recently
   * finished first, at most `limit` of them, with how many it owns in all (`TaskList`).
   */
  async finishedOwnedBy(
    conversationId: string,
    limit: number,
  ): Promise<{ rows: BackgroundTaskRow[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.db
        .selectFrom("background_tasks")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("status", "<>", "running")
        .orderBy("finished_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute(),
      this.db
        .selectFrom("background_tasks")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("conversation_id", "=", conversationId)
        .where("status", "<>", "running")
        .executeTakeFirstOrThrow(),
    ]);
    return { rows: rows.map(toRow), total: Number(count.n) };
  }

  /** The running tasks of one root conversation's tree (what `maxTasks` limits). */
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
    opts: { unclaimed?: boolean; managed?: "terminal" | "cancel-pending" } = {},
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
        // a managed task's settlement: `terminal` only on verified evidence; an uncertain end
        // (lost) keeps its owed cancellation record
        ...(opts.managed !== undefined && {
          launch_state: sql<BackgroundLaunchState>`CASE WHEN launch_state = 'legacy' THEN 'legacy' ELSE ${opts.managed} END`,
        }),
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

  /**
   * Finished tasks of a device whose process may still exist (any conversation's: they
   * share the instance).
   */
  async pendingKills(deviceId: string): Promise<BackgroundTaskRow[]> {
    const rows = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("device_id", "=", deviceId)
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

  /**
   * Deletes finished tasks that ended before `before`; a running one is never deleted, nor a
   * managed record whose launch or cancellation is still uncertain (only `legacy` and settled
   * `terminal` rows go).
   */
  async pruneFinished(before: Date): Promise<number> {
    const r = await this.db
      .deleteFrom("background_tasks")
      .where("status", "<>", "running")
      .where("launch_state", "in", ["legacy", "terminal"])
      .where("finished_at", "<", before)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }
}
