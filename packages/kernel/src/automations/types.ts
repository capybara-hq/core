import type { EventFilter } from "@capybara-hq/plugin-sdk";
import type { ModelRef } from "../agents/definition.js";

/**
 * Automations (spec 2026-11-11-scheduled-tasks-design.md §4): the shapes the kernel reads and
 * writes. The rows live in `capybara.automations`, `automation_runs` and
 * `automation_grants` (migration 0113).
 */

/**
 * When an automation fires: a 5-field cron, or once at a local date-time, both in an IANA zone
 * (§5); or on an extension's trigger events (collaboration spec §4.1): events of `types` from the
 * extension `source` whose facts match `filter`. An event automation has no next run time.
 */
export type AutomationTrigger =
  | { kind: "cron"; expr: string; timeZone: string }
  | { kind: "once"; at: string /* local ISO date-time, no offset */; timeZone: string }
  | { kind: "event"; source: string; types: string[]; filter: EventFilter };

/** The time triggers: the ones with a next run time. */
export type AutomationTimeTrigger = Exclude<AutomationTrigger, { kind: "event" }>;

/**
 * Where a run posts: a new conversation, one existing conversation, an IM chat (§3), or one
 * conversation per event subject (collaboration spec §4.5).
 */
export type AutomationMode = "new" | "conversation" | "chat" | "subject";

/** Who made an automation: its owner, or the kernel from an acceptance rule (collaboration §4.4). */
export type AutomationOrigin = "person" | "acceptance";

/** Whom an automation acts as (`automations.principal`); today always the member `account_id`. */
export type AutomationPrincipal = { kind: "member"; accountId: string };

/** What a question asked in an unattended run does (collaboration spec §4.7). */
export type AutomationUnattendedAsk = "fail" | "wait";

/** The IM chat a `chat`-mode task posts into. */
export interface AutomationChat {
  connectionId: string;
  chatId: string;
  chatType: "dm" | "group";
}

export type AutomationStatus = "active" | "paused" | "ended";

export type AutomationPauseReason =
  | "creator"
  | "admin"
  | "failures"
  | "creator_inactive"
  | "agent_gone"
  | "target_gone"
  | "conversation_gone"
  | "org_disabled"
  | "expired"
  /** The stored trigger cannot be evaluated (the scanner stops selecting the task). */
  | "invalid_schedule";

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
  | "org_disabled"
  /** The channel's extension is disabled in the org: the task stays active. */
  | "plugin_disabled"
  /** A group chat on a channel without threads (a group run needs its own thread). */
  | "unsupported_target"
  /** The task was deleted after the run was recorded. */
  | "task_deleted"
  /** The task was paused after the scan recorded the tick (a "run now" still runs). */
  | "task_paused"
  /** An event run: the event's subject is not visible to the automation's principal. */
  | "not_visible"
  /** An event run: the subject's run rate limit was reached (collaboration spec §4.7). */
  | "subject_rate";

/** A task as the kernel reads it: the columns of `capybara.automations`, camel-cased. */
export interface Automation {
  id: string;
  orgId: string;
  /** The creator: every run acts as this account. */
  accountId: string;
  agentId: string;
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
  mode: AutomationMode;
  /** The target conversation (`conversation` mode only). */
  conversationId: string | null;
  /** The target chat (`chat` mode only). */
  chat: AutomationChat | null;
  /** Null = the agent's default model. */
  model: ModelRef | null;
  /** Null = the agent's default effort. */
  effort: string | null;
  /** Null = the default pick for new conversations. */
  deviceId: string | null;
  /** What a question in an unattended run does; null = the org's default. */
  unattendedAsk: AutomationUnattendedAsk | null;
  status: AutomationStatus;
  pauseReason: AutomationPauseReason | null;
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

/** One tick of a task (or a trial run): the columns of `capybara.automation_runs`. */
export interface TaskRun {
  id: string;
  taskId: string;
  orgId: string;
  /**
   * The tick, before jitter (for a trial run: when it was requested); null for an event run
   * (collaboration spec §4.1).
   */
  scheduledFor: Date | null;
  /**
   * What the run is unique by outside trials: the tick as `Date.toISOString()` for a time run, the
   * event id for an event run (`UNIQUE (automation_id, trigger_key) WHERE NOT trial`).
   */
  triggerKey: string;
  firedAt: Date | null;
  trial: boolean;
  /** A person's "run now" (trial or not), outside the schedule. */
  manual: boolean;
  conversationId: string | null;
  runId: string | null;
  status: TaskRunStatus;
  skipReason: TaskRunSkipReason | null;
  error: string | null;
  /** Tool keys refused for lack of a grant (§7). */
  missingGrants: string[];
}

/** A run with a tick: every time run (event runs have none). */
export type TimedTaskRun = TaskRun & { scheduledFor: Date };

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

/**
 * The marker an event automation's message carries (`conversation_queue.automation_event`, then
 * `user_message.automationEvent`, collaboration spec §4.6): the automation and run, and the
 * events the message reports, in order (coalesced events share one message).
 */
export interface AutomationEventMarker {
  automationId: string;
  automationRunId: string;
  automationName: string;
  /** The extension that emitted the events (the automation's trigger source). */
  source: string;
  events: Array<{
    id: string;
    type: string;
    subject: { kind: string; id: string; title: string; url?: string | undefined };
    summary: string;
  }>;
}

/** A remembered "always allow" of a task (same meaning as `conversation_tool_grants`). */
export interface AutomationGrant {
  toolKey: string;
  specHash: string;
  connectorId: string | null;
}
