import type { OutboxService } from "../infra/outbox/outbox.service.js";

/** The automations' jobs (a leaf module: type imports only). */

/**
 * The once-a-minute `@LockedCron` that turns due tasks into task runs (spec §6); its name enqueued
 * on the maintenance queue runs one scan (`ScheduledRuns.runNow`).
 */
export const AUTOMATION_SCAN_JOB = "automation-scan";

/** The one-off job that checks and starts one task run, on `cap-kernel-maintenance`. */
export const AUTOMATION_FIRE_JOB = "automation-fire";

/** The data of a {@link AUTOMATION_FIRE_JOB}. */
export interface AutomationFireJobData {
  taskRunId: string;
}

/** The fire job's id: `automation-fire-<taskRunId>` (no `:`, task run ids are UUIDs). */
export const automationFireJobId = (taskRunId: string): string =>
  `${AUTOMATION_FIRE_JOB}-${taskRunId}`;

/**
 * Owes the fire job of task run `taskRunId` in the transaction in context (transactional outbox
 * spec §8.1): the transaction that writes a pending task run (the scan's tick, a person's "run
 * now") owes its fire, so a tick is never left unfired. The job's options are its outbox registry
 * entry's; the fire is idempotent on the task run's status.
 */
export function oweAutomationFire(
  outbox: Pick<OutboxService, "add">,
  taskRunId: string,
  orgId: string,
): Promise<boolean> {
  return outbox.add<AutomationFireJobData>({
    queue: "cap-kernel-maintenance",
    name: AUTOMATION_FIRE_JOB,
    jobId: automationFireJobId(taskRunId),
    data: { taskRunId },
    orgId,
  });
}

/**
 * The delayed job that settles a task run left pending (ruling R26, fix round 1), on
 * `cap-kernel-maintenance`. Two kinds:
 * - the claimed check, owed by the fire job's claim: the run tracker links, settles or releases a
 *   run claimed but never started (`automation-settle-<taskRunId>`, then `-<check>`);
 * - the unfired check, owed with the task run itself (the scan's tick, "run now"): a run its fire
 *   job never claimed (the job failed for good before its claim) is skipped, `missed` for a tick,
 *   `removed` for a "run now", so it never blocks the task's later ticks as an overlap
 *   (`automation-settle-<taskRunId>-unfired`).
 */
export const AUTOMATION_SETTLE_JOB = "automation-settle";

/**
 * The data of a {@link AUTOMATION_SETTLE_JOB}: the claimed check (`check` counts the checks before this
 * one) or the unfired check.
 */
export type AutomationSettleJobData =
  | { taskRunId: string; check: number }
  | { taskRunId: string; unfired: true };

/**
 * The first claimed check: 10 minutes after the claim, when the start's retries (seconds) are long
 * over and the run tracker's start grace (`START_GRACE_MS`, 5 minutes) has passed, so a run that
 * left no trace is released at once. Also the unfired check's delay after a "run now".
 */
export const AUTOMATION_SETTLE_AFTER_MS = 10 * 60_000;
/**
 * A claimed run still in flight at a check (its item queued, its message posted and not yet taken
 * by a run) is checked again hourly. The chain ends with the first check that finds the run
 * started, ended or released: the queued item is consumed or removed, the message taken by a run.
 * A chain past {@link AUTOMATION_SETTLE_LONG_CHECKS} checks (a week) is logged as a warning, once.
 */
export const AUTOMATION_SETTLE_RECHECK_MS = 60 * 60_000;
/** A week of hourly checks: the claimed check warns at this one (a run in flight that long). */
export const AUTOMATION_SETTLE_LONG_CHECKS = 168;
/**
 * How long past the org's catch-up window a tick's fire may come before the tick is missed (the
 * fire job's own rule, and when a tick's unfired check runs): the scan fires a tick still inside
 * the window, and its fire job follows within seconds.
 */
export const AUTOMATION_LATE_FIRE_SLACK_MS = 10 * 60_000;

/** The claimed check's id: `automation-settle-<taskRunId>`, then `-<check>` for the later checks. */
export const automationSettleJobId = (taskRunId: string, check: number): string =>
  check === 0
    ? `${AUTOMATION_SETTLE_JOB}-${taskRunId}`
    : `${AUTOMATION_SETTLE_JOB}-${taskRunId}-${check}`;

/** The unfired check's id: `automation-settle-<taskRunId>-unfired`. */
export const automationSettleUnfiredJobId = (taskRunId: string): string =>
  `${AUTOMATION_SETTLE_JOB}-${taskRunId}-unfired`;

/**
 * Owes claimed check number `check` of task run `taskRunId` in the transaction in context, due
 * `after` milliseconds from now.
 */
export function oweAutomationSettle(
  outbox: Pick<OutboxService, "add">,
  taskRunId: string,
  orgId: string,
  check: number,
  after: number,
): Promise<boolean> {
  return outbox.add<AutomationSettleJobData>({
    queue: "cap-kernel-maintenance",
    name: AUTOMATION_SETTLE_JOB,
    jobId: automationSettleJobId(taskRunId, check),
    data: { taskRunId, check },
    runAt: new Date(Date.now() + after),
    orgId,
  });
}

/**
 * Owes the unfired check of task run `taskRunId` in the transaction that writes the run: for a
 * tick of the schedule (`catchUpWindowMinutes` given) when the fire job would itself call the
 * tick missed (its tick plus the window plus {@link AUTOMATION_LATE_FIRE_SLACK_MS}, at least
 * {@link AUTOMATION_SETTLE_AFTER_MS} on); for a "run now" (null) {@link AUTOMATION_SETTLE_AFTER_MS} on.
 */
export function oweAutomationSettleUnfired(
  outbox: Pick<OutboxService, "add">,
  taskRunId: string,
  orgId: string,
  /** The run's tick; null for an event run (no tick: settled like a "run now"). */
  scheduledFor: Date | null,
  catchUpWindowMinutes: number | null,
): Promise<boolean> {
  const soonest = Date.now() + AUTOMATION_SETTLE_AFTER_MS;
  const at =
    catchUpWindowMinutes === null || scheduledFor === null
      ? soonest
      : Math.max(
          soonest,
          scheduledFor.getTime() + catchUpWindowMinutes * 60_000 + AUTOMATION_LATE_FIRE_SLACK_MS,
        );
  return outbox.add<AutomationSettleJobData>({
    queue: "cap-kernel-maintenance",
    name: AUTOMATION_SETTLE_JOB,
    jobId: automationSettleUnfiredJobId(taskRunId),
    data: { taskRunId, unfired: true },
    runAt: new Date(at),
    orgId,
  });
}

/**
 * The one-off job that routes one trigger event to the automations it fires (collaboration spec
 * §4.2), on `cap-kernel-maintenance`, owed by the transaction that stores the event.
 */
export const TRIGGER_DISPATCH_JOB = "trigger-dispatch";

/** The data of a {@link TRIGGER_DISPATCH_JOB}. */
export interface TriggerDispatchJobData {
  orgId: string;
  eventId: string;
}

/** The dispatch job's id: `trigger-dispatch-<eventId>` (no `:`, event ids are UUIDs). */
export const triggerDispatchJobId = (eventId: string): string =>
  `${TRIGGER_DISPATCH_JOB}-${eventId}`;

/**
 * The delayed job that turns one window of an event automation's events for one subject into one
 * run (collaboration spec §4.7), on `cap-kernel-maintenance`, owed by the dispatch that opens the
 * window: the first event delivered to the (automation, subject) pair while none waits for a run.
 */
export const AUTOMATION_COALESCE_JOB = "automation-coalesce";

/** The data of a {@link AUTOMATION_COALESCE_JOB}. */
export interface AutomationCoalesceJobData {
  orgId: string;
  automationId: string;
  /** `subjectKey(subject)` of the events (`automation_event_deliveries.subject_key`). */
  subjectKey: string;
}
