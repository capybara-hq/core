/**
 * Scheduled tasks (spec 2026-11-11-scheduled-tasks-design.md §4): the shapes the kernel reads and
 * writes. The rows live in `capybara.scheduled_tasks`, `scheduled_task_runs` and
 * `scheduled_task_grants` (migration 0109).
 */

/** When a task fires: a 5-field cron, or once at a local date-time, both in an IANA zone (§5). */
export type ScheduleTrigger =
  | { kind: "cron"; expr: string; timeZone: string }
  | { kind: "once"; at: string /* local ISO date-time, no offset */; timeZone: string };

/** Where a run posts: a new conversation, one existing conversation, or an IM chat (§3). */
export type ScheduleMode = "new" | "conversation" | "chat";

/** The IM chat a `chat`-mode task posts into. */
export interface ScheduleChat {
  connectionId: string;
  chatId: string;
  chatType: "dm" | "group";
}

export type ScheduleStatus = "active" | "paused" | "ended";

export type SchedulePauseReason =
  | "creator"
  | "admin"
  | "failures"
  | "creator_inactive"
  | "agent_gone"
  | "target_gone"
  | "conversation_gone"
  | "org_disabled"
  | "expired";

export type TaskRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type TaskRunSkipReason =
  | "missed"
  | "overlap"
  | "rate_limited"
  | "queue_paused"
  | "removed"
  | "device_offline"
  | "creator_inactive"
  | "agent_gone"
  | "target_gone"
  | "conversation_gone"
  | "org_disabled";

/** A task as the kernel reads it: the columns of `capybara.scheduled_tasks`, camel-cased. */
export interface ScheduledTask {
  id: string;
  orgId: string;
  /** The creator: every run acts as this account. */
  accountId: string;
  agentId: string;
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
  mode: ScheduleMode;
  /** The target conversation (`conversation` mode only). */
  conversationId: string | null;
  /** The target chat (`chat` mode only). */
  chat: ScheduleChat | null;
  /** Null = the agent's default model. */
  model: string | null;
  /** Null = the agent's default effort. */
  effort: string | null;
  /** Null = the default pick for new conversations. */
  deviceId: string | null;
  status: ScheduleStatus;
  pauseReason: SchedulePauseReason | null;
  /** The account that paused the task (creator or admin); null when not paused by a person. */
  pausedBy: string | null;
  /** The next fire time, jitter included; null when the task is not active. */
  nextRunAt: Date | null;
  jitterSeconds: number;
  expiresAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One tick of a task (or a trial run): the columns of `capybara.scheduled_task_runs`. */
export interface TaskRun {
  id: string;
  taskId: string;
  orgId: string;
  /** The tick, before jitter (for a trial run: when it was requested). */
  scheduledFor: Date;
  firedAt: Date | null;
  trial: boolean;
  conversationId: string | null;
  runId: string | null;
  status: TaskRunStatus;
  skipReason: TaskRunSkipReason | null;
  error: string | null;
  /** Tool keys refused for lack of a grant (§7). */
  missingGrants: string[];
}

/**
 * The marker a task's message carries (`conversation_queue.schedule`, then `user_message`): not
 * model-visible as such; `taskName` and `localTime` feed the English header the model sees.
 */
export interface ScheduleMarker {
  taskId: string;
  taskRunId: string;
  /** ISO timestamp of the tick. */
  scheduledFor: string;
  trial: boolean;
  taskName: string;
  /** The tick in the task's zone, as the header shows it. */
  localTime: string;
}

/** A remembered "always allow" of a task (same meaning as `conversation_tool_grants`). */
export interface ScheduledTaskGrant {
  toolKey: string;
  specHash: string;
  connectorId: string | null;
}
