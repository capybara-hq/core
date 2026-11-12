import { Injectable } from "@nestjs/common";
import type { Selectable, Updateable } from "kysely";
import { sql } from "kysely";
import type {
  KernelSchemaDb,
  ScheduledTaskRunsTable,
  ScheduledTasksTable,
} from "../db/kernel-schema.js";
import type { ScheduledTask, ScheduledTaskGrant, TaskRun, TaskRunStatus } from "./types.js";

/** What a caller supplies to create a task; the counters, pause fields and timestamps default. */
export type ScheduledTaskInsert = Omit<
  ScheduledTask,
  "pauseReason" | "pausedBy" | "consecutiveFailures" | "createdAt" | "updatedAt"
>;

/** The fields a task update may change (`updated_at` is always refreshed). */
export type ScheduledTaskPatch = Partial<
  Omit<ScheduledTask, "id" | "orgId" | "accountId" | "createdAt" | "updatedAt">
>;

/** What a caller supplies to create a task run; it starts `pending`. */
export interface TaskRunInsert {
  id: string;
  taskId: string;
  orgId: string;
  scheduledFor: Date;
  trial: boolean;
  /** A person's "run now" (default false: a tick of the schedule). */
  manual?: boolean;
  status?: TaskRunStatus;
  skipReason?: TaskRun["skipReason"];
  firedAt?: Date | null;
  conversationId?: string | null;
}

export type TaskRunPatch = Partial<Omit<TaskRun, "id" | "taskId" | "orgId" | "trial" | "manual">>;

const NON_TERMINAL: TaskRunStatus[] = ["pending", "running"];

const date = (v: Date | string) => (v instanceof Date ? v : new Date(v));
const dateOrNull = (v: Date | string | null) => (v === null ? null : date(v));

const toTask = (r: Selectable<ScheduledTasksTable>): ScheduledTask => ({
  id: r.id,
  orgId: r.org_id,
  accountId: r.account_id,
  agentId: r.agent_id,
  name: r.name,
  prompt: r.prompt,
  trigger: r.trigger,
  mode: r.mode,
  conversationId: r.conversation_id,
  chat: r.chat,
  model: r.model,
  effort: r.effort,
  deviceId: r.device_id,
  status: r.status,
  pauseReason: r.pause_reason,
  pausedBy: r.paused_by,
  nextRunAt: dateOrNull(r.next_run_at),
  jitterSeconds: r.jitter_seconds,
  expiresAt: dateOrNull(r.expires_at),
  consecutiveFailures: r.consecutive_failures,
  createdAt: date(r.created_at),
  updatedAt: date(r.updated_at),
});

const toRun = (r: Selectable<ScheduledTaskRunsTable>): TaskRun => ({
  id: r.id,
  taskId: r.task_id,
  orgId: r.org_id,
  scheduledFor: date(r.scheduled_for),
  firedAt: dateOrNull(r.fired_at),
  trial: r.trial,
  manual: r.manual,
  conversationId: r.conversation_id,
  runId: r.run_id,
  status: r.status,
  skipReason: r.skip_reason,
  error: r.error,
  missingGrants: r.missing_grants,
});

const json = (v: unknown) => (v === null ? null : JSON.stringify(v));

/** Maps a task patch to its columns; fields left undefined are not written. */
function taskColumns(p: ScheduledTaskPatch): Updateable<ScheduledTasksTable> {
  const c: Updateable<ScheduledTasksTable> = {};
  if (p.agentId !== undefined) c.agent_id = p.agentId;
  if (p.name !== undefined) c.name = p.name;
  if (p.prompt !== undefined) c.prompt = p.prompt;
  if (p.trigger !== undefined) c.trigger = JSON.stringify(p.trigger);
  if (p.mode !== undefined) c.mode = p.mode;
  if (p.conversationId !== undefined) c.conversation_id = p.conversationId;
  if (p.chat !== undefined) c.chat = json(p.chat);
  if (p.model !== undefined) c.model = json(p.model);
  if (p.effort !== undefined) c.effort = p.effort;
  if (p.deviceId !== undefined) c.device_id = p.deviceId;
  if (p.status !== undefined) c.status = p.status;
  if (p.pauseReason !== undefined) c.pause_reason = p.pauseReason;
  if (p.pausedBy !== undefined) c.paused_by = p.pausedBy;
  if (p.nextRunAt !== undefined) c.next_run_at = p.nextRunAt;
  if (p.jitterSeconds !== undefined) c.jitter_seconds = p.jitterSeconds;
  if (p.expiresAt !== undefined) c.expires_at = p.expiresAt;
  if (p.consecutiveFailures !== undefined) c.consecutive_failures = p.consecutiveFailures;
  return c;
}

/**
 * Scheduled tasks, their runs and grants (spec §4): reads and writes rows only. Every method takes
 * the database handle first so the caller decides the transaction (the scanner's `lockDue` and
 * `insertRun` run in one, under the rows' locks).
 */
@Injectable()
export class ScheduledTaskStore {
  async insertTask(t: KernelSchemaDb, task: ScheduledTaskInsert): Promise<ScheduledTask> {
    const row = await t
      .insertInto("scheduled_tasks")
      .values({
        id: task.id,
        org_id: task.orgId,
        account_id: task.accountId,
        agent_id: task.agentId,
        name: task.name,
        prompt: task.prompt,
        trigger: JSON.stringify(task.trigger),
        mode: task.mode,
        conversation_id: task.conversationId,
        chat: json(task.chat),
        model: json(task.model),
        effort: task.effort,
        device_id: task.deviceId,
        status: task.status,
        next_run_at: task.nextRunAt,
        jitter_seconds: task.jitterSeconds,
        expires_at: task.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTask(row);
  }

  /** A live (not deleted) task of the org; null when missing, deleted or in another org. */
  async getTask(t: KernelSchemaDb, orgId: string, id: string): Promise<ScheduledTask | null> {
    const row = await t
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row ? toTask(row) : null;
  }

  /**
   * {@link getTask} under `FOR UPDATE` (call it inside a transaction): a person's write holds the
   * row, so the scanner's `lockDue` skips it until the write commits.
   */
  async lockTask(t: KernelSchemaDb, orgId: string, id: string): Promise<ScheduledTask | null> {
    const row = await t
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    return row ? toTask(row) : null;
  }

  /** Patches a live task; null when it is missing or deleted. */
  async updateTask(
    t: KernelSchemaDb,
    id: string,
    patch: ScheduledTaskPatch,
  ): Promise<ScheduledTask | null> {
    const row = await t
      .updateTable("scheduled_tasks")
      .set({ ...taskColumns(patch), updated_at: sql`now()` })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? toTask(row) : null;
  }

  /** Deletes a task softly: hidden from every read and never due again. */
  async softDelete(t: KernelSchemaDb, id: string): Promise<boolean> {
    const r = await t
      .updateTable("scheduled_tasks")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()`, next_run_at: null })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  }

  /** A creator's live tasks, newest first. */
  async listForAccount(
    t: KernelSchemaDb,
    orgId: string,
    accountId: string,
  ): Promise<ScheduledTask[]> {
    const rows = await t
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map(toTask);
  }

  /** Every live task of the org, newest first. */
  async listForOrg(t: KernelSchemaDb, orgId: string): Promise<ScheduledTask[]> {
    const rows = await t
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map(toTask);
  }

  /** Live tasks that count against the caps (`active` and `paused`), of the org or one creator. */
  async countActive(t: KernelSchemaDb, orgId: string, accountId?: string): Promise<number> {
    let q = t
      .selectFrom("scheduled_tasks")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where("status", "in", ["active", "paused"]);
    if (accountId !== undefined) q = q.where("account_id", "=", accountId);
    const row = await q.executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Locks up to `limit` due tasks (active, live, `next_run_at <= now`), oldest first, skipping
   * rows another transaction holds (`FOR UPDATE SKIP LOCKED`). Call it inside a transaction: the
   * locks last until it ends.
   */
  async lockDue(t: KernelSchemaDb, now: Date, limit: number): Promise<ScheduledTask[]> {
    const rows = await t
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .where("next_run_at", "<=", now)
      .orderBy("next_run_at")
      .orderBy("id")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    return rows.map(toTask);
  }

  /**
   * Inserts a task run; null when a non-trial run for the same tick already exists (the
   * exactly-once guard, `UNIQUE (task_id, scheduled_for) WHERE NOT trial`).
   */
  async insertRun(t: KernelSchemaDb, run: TaskRunInsert): Promise<TaskRun | null> {
    const row = await t
      .insertInto("scheduled_task_runs")
      .values({
        id: run.id,
        task_id: run.taskId,
        org_id: run.orgId,
        scheduled_for: run.scheduledFor,
        trial: run.trial,
        manual: run.manual ?? false,
        status: run.status ?? "pending",
        skip_reason: run.skipReason ?? null,
        fired_at: run.firedAt ?? null,
        conversation_id: run.conversationId ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["task_id", "scheduled_for"]).where("trial", "=", false).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? toRun(row) : null;
  }

  /** Patches a task run; null when it does not exist. */
  async updateRun(t: KernelSchemaDb, id: string, patch: TaskRunPatch): Promise<TaskRun | null> {
    const c: Updateable<ScheduledTaskRunsTable> = {};
    if (patch.scheduledFor !== undefined) c.scheduled_for = patch.scheduledFor;
    if (patch.firedAt !== undefined) c.fired_at = patch.firedAt;
    if (patch.conversationId !== undefined) c.conversation_id = patch.conversationId;
    if (patch.runId !== undefined) c.run_id = patch.runId;
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.skipReason !== undefined) c.skip_reason = patch.skipReason;
    if (patch.error !== undefined) c.error = patch.error;
    if (patch.missingGrants !== undefined) c.missing_grants = JSON.stringify(patch.missingGrants);
    if (Object.keys(c).length === 0) {
      const row = await t
        .selectFrom("scheduled_task_runs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toRun(row) : null;
    }
    const row = await t
      .updateTable("scheduled_task_runs")
      .set(c)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row ? toRun(row) : null;
  }

  /**
   * The task's latest run still `pending` or `running` (the overlap check), other than `exceptId`
   * (the run being fired); null when none.
   */
  async latestNonTerminalRun(
    t: KernelSchemaDb,
    taskId: string,
    exceptId?: string,
  ): Promise<TaskRun | null> {
    let q = t
      .selectFrom("scheduled_task_runs")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("status", "in", NON_TERMINAL);
    if (exceptId !== undefined) q = q.where("id", "!=", exceptId);
    const row = await q
      .orderBy("scheduled_for", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toRun(row) : null;
  }

  /**
   * Runs of the org fired at or after `since` (the `maxRunsPerHour` count; trial runs included,
   * skipped runs not: a run whose queued message a person removed was never run).
   */
  async countFiredSince(t: KernelSchemaDb, orgId: string, since: Date): Promise<number> {
    const row = await t
      .selectFrom("scheduled_task_runs")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("fired_at", ">=", since)
      .where("status", "!=", "skipped")
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** A task's runs, latest tick first. */
  async listRuns(t: KernelSchemaDb, taskId: string, limit: number): Promise<TaskRun[]> {
    const rows = await t
      .selectFrom("scheduled_task_runs")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("scheduled_for", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toRun);
  }

  /**
   * The runs of these tasks of the org with `scheduled_for` in `[from, to)`, trial included, by tick, at most
   * `limit` (the calendar; `scheduled_task_runs_task_idx` per task).
   */
  async listRunsBetween(
    t: KernelSchemaDb,
    orgId: string,
    taskIds: readonly string[],
    from: Date,
    to: Date,
    limit: number,
  ): Promise<TaskRun[]> {
    if (taskIds.length === 0) return [];
    const rows = await t
      .selectFrom("scheduled_task_runs")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("task_id", "in", [...taskIds])
      .where("scheduled_for", ">=", from)
      .where("scheduled_for", "<", to)
      .orderBy("scheduled_for")
      .orderBy("id")
      .limit(limit)
      .execute();
    return rows.map(toRun);
  }

  async listGrants(t: KernelSchemaDb, taskId: string): Promise<ScheduledTaskGrant[]> {
    const rows = await t
      .selectFrom("scheduled_task_grants")
      .select(["tool_key", "spec_hash", "connector_id"])
      .where("task_id", "=", taskId)
      .orderBy("tool_key")
      .execute();
    return rows.map((r) => ({
      toolKey: r.tool_key,
      specHash: r.spec_hash,
      connectorId: r.connector_id,
    }));
  }

  /** Adds a grant, replacing the task's grant of the same tool key. */
  async addGrant(t: KernelSchemaDb, taskId: string, grant: ScheduledTaskGrant): Promise<void> {
    await t
      .insertInto("scheduled_task_grants")
      .values({
        task_id: taskId,
        tool_key: grant.toolKey,
        spec_hash: grant.specHash,
        connector_id: grant.connectorId,
      })
      .onConflict((oc) =>
        oc.columns(["task_id", "tool_key"]).doUpdateSet({
          spec_hash: grant.specHash,
          connector_id: grant.connectorId,
          created_at: sql`now()`,
        }),
      )
      .execute();
  }

  async removeGrant(t: KernelSchemaDb, taskId: string, toolKey: string): Promise<boolean> {
    const r = await t
      .deleteFrom("scheduled_task_grants")
      .where("task_id", "=", taskId)
      .where("tool_key", "=", toolKey)
      .executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }
}

/**
 * Whether the task holds a grant for this tool as defined now: same key, same spec hash, same
 * connector (null for plugin and builtin tools). A grant of an older definition does not count.
 * A plain function too, for the tool policy (`createDecidePolicy`), which is not a provider.
 */
export async function findTaskGrant(
  t: KernelSchemaDb,
  taskId: string,
  toolKey: string,
  specHash: string,
  connectorId: string | null,
): Promise<boolean> {
  const row = await t
    .selectFrom("scheduled_task_grants")
    .select("tool_key")
    .where("task_id", "=", taskId)
    .where("tool_key", "=", toolKey)
    .where("spec_hash", "=", specHash)
    .where(sql<boolean>`connector_id IS NOT DISTINCT FROM ${connectorId}`)
    .executeTakeFirst();
  return row !== undefined;
}
