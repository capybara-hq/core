import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/**
 * The kernel's scheduled tasks API (`packages/kernel/src/schedules/schedules.controller.ts`,
 * spec 2026-11-11-scheduled-tasks §10; only the fields the UI uses). Web code never imports
 * kernel code.
 */

export type ScheduleTrigger =
  | { kind: "cron"; expr: string; timeZone: string }
  | { kind: "once"; at: string; timeZone: string };

export type ScheduleMode = "new" | "conversation" | "chat";

export interface ScheduleChat {
  connectionId: string;
  chatId: string;
  chatType: "dm" | "group";
}

export type ScheduleStatus = "active" | "paused" | "ended";

export const PAUSE_REASONS = [
  "creator",
  "admin",
  "failures",
  "creator_inactive",
  "agent_gone",
  "target_gone",
  "conversation_gone",
  "org_disabled",
  "expired",
  "invalid_schedule",
] as const;
export type SchedulePauseReason = (typeof PAUSE_REASONS)[number];

export type TaskRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export const SKIP_REASONS = [
  "missed",
  "overlap",
  "rate_limited",
  "queue_paused",
  "removed",
  "device_offline",
  "creator_inactive",
  "agent_gone",
  "target_gone",
  "conversation_gone",
  "org_disabled",
  "unsupported_target",
  "task_deleted",
  "task_paused",
] as const;
export type TaskRunSkipReason = (typeof SKIP_REASONS)[number];

export const SCHEDULE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ScheduleEffort = (typeof SCHEDULE_EFFORTS)[number];

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
  conversationId: string | null;
  chat: ScheduleChat | null;
  /** Null: the agent's model. */
  model: ModelRef | null;
  /** Null: the agent's effort. */
  effort: string | null;
  deviceId: string | null;
  status: ScheduleStatus;
  pauseReason: SchedulePauseReason | null;
  pausedBy: string | null;
  /** The next fire time, jitter included; null when not active. */
  nextRunAt: string | null;
  jitterSeconds: number;
  expiresAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

/** The latest settled non-trial run of a task, as the list carries it. */
export interface TaskLastRun {
  status: "completed" | "failed" | "skipped";
  skipReason: TaskRunSkipReason | null;
  /** When it fired (its tick for a skipped one). */
  at: string;
}

/** A task in a list, with its latest settled run. */
export type ScheduledTaskListItem = ScheduledTask & { lastRun: TaskLastRun | null };

/** A chat a `chat` task can post into (`GET …/schedules/chat-targets`). */
export interface ChatTarget {
  connectionId: string;
  connectionName: string;
  plugin: string;
  /** The connection's agent: the task's agent. */
  agentId: string;
  chatId: string;
  chatType: "dm" | "group";
  label: string;
}

/** Why a tool can't be approved in advance (kernel `GrantRefusalCode`). */
export type GrantRefusal =
  | "forbidden"
  | "not_grantable"
  | "not_available"
  | "needs_role"
  | "fixed_ask";

/** One of an agent's tools as the grant picker offers it (`GET …/schedules/grantable-tools`). */
export interface GrantableTool {
  key: string;
  title: string | null;
  source: "builtin" | "plugin" | "connector";
  connectorId: string | null;
  grantable: boolean;
  reason: GrantRefusal | null;
}

export interface TaskRun {
  id: string;
  taskId: string;
  scheduledFor: string;
  firedAt: string | null;
  trial: boolean;
  conversationId: string | null;
  runId: string | null;
  status: TaskRunStatus;
  skipReason: TaskRunSkipReason | null;
  error: string | null;
  /**
   * Tool keys refused for lack of a grant; `connection:<slug>` for a connector to connect;
   * `network:<host>` for a domain the run was refused.
   */
  missingGrants: string[];
}

/**
 * A tool the task may use without asking, or a domain (`toolKey: "network:<host>"`, `specHash:
 * "network"`, no connector: its unattended runs may reach the host on the task's device).
 */
export interface ScheduledTaskGrant {
  toolKey: string;
  specHash: string;
  connectorId: string | null;
  /**
   * The tool changed since it was approved: the approval no longer applies (spec §7); null when
   * the kernel could not read the agent's tools just now. Always false for a domain.
   */
  stale?: boolean | null;
}

/** When a task fires, before the zone is fixed (the create / patch body's `trigger`). */
export type TriggerInput = { kind: "cron"; expr: string } | { kind: "once"; at: string };

export interface ScheduleCreateBody {
  agentId: string;
  name: string;
  prompt: string;
  trigger: TriggerInput;
  /** The browser's zone: used only when the account has none. */
  timeZone?: string;
  mode: ScheduleMode;
  conversationId?: string;
  chat?: ScheduleChat;
  model?: ModelRef;
  effort?: ScheduleEffort;
  expiresAt?: string | null;
  /** Tools by key, domains as `network:<host>` (one exact host). */
  grants?: { toolKey: string }[];
}

export interface ScheduleUpdateBody {
  agentId?: string;
  name?: string;
  prompt?: string;
  trigger?: TriggerInput;
  timeZone?: string;
  mode?: ScheduleMode;
  conversationId?: string | null;
  chat?: ScheduleChat | null;
  model?: ModelRef | null;
  effort?: ScheduleEffort | null;
  expiresAt?: string | null;
}

/** The org's scheduled-tasks settings (`orgs.settings.scheduledTasks`, spec §9). */
export interface ScheduledTasksSettings {
  enabled: boolean;
  minIntervalMinutes: number;
  maxTasksPerMember: number;
  maxTasksPerOrg: number;
  maxRunsPerHour: number;
  defaultExpiryDays: number | null;
  catchUpWindowMinutes: number;
  unattendedAsk: "fail" | "wait";
  pauseAfterFailures: number;
  forbiddenTools: string[];
}

/** The defaults of spec §9 (an older kernel leaves the group out). */
export const SCHEDULE_SETTINGS_DEFAULTS: ScheduledTasksSettings = {
  enabled: true,
  minIntervalMinutes: 60,
  maxTasksPerMember: 20,
  maxTasksPerOrg: 200,
  maxRunsPerHour: 60,
  defaultExpiryDays: null,
  catchUpWindowMinutes: 60,
  unattendedAsk: "fail",
  pauseAfterFailures: 5,
  forbiddenTools: [],
};

const enc = encodeURIComponent;
const base = (orgId: string) => `/api/v1/orgs/${enc(orgId)}/schedules`;
const one = (orgId: string, id: string) => `${base(orgId)}/${enc(id)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** My tasks; `all`: every task of the org (org admins). */
export const listSchedules = (orgId: string, all = false) =>
  apiFetch<{ items: ScheduledTaskListItem[] }>(`${base(orgId)}${all ? "?all=true" : ""}`);

/** My tasks that post into a conversation (its side panel). */
export const listConversationSchedules = (orgId: string, conversationId: string) =>
  apiFetch<{ items: ScheduledTaskListItem[] }>(
    `${base(orgId)}?conversationId=${enc(conversationId)}`,
  );

/** The chats a `chat` task of mine can post into. */
export const listChatTargets = (orgId: string) =>
  apiFetch<{ items: ChatTarget[] }>(`${base(orgId)}/chat-targets`);

/** An agent's tools, each grantable in advance or why not. */
export const listGrantableTools = (orgId: string, agentId: string) =>
  apiFetch<{ items: GrantableTool[] }>(`${base(orgId)}/grantable-tools?agentId=${enc(agentId)}`);

export const getSchedule = (orgId: string, id: string) =>
  apiFetch<{ task: ScheduledTask }>(one(orgId, id));

export const createSchedule = (orgId: string, body: ScheduleCreateBody) =>
  apiFetch<{ task: ScheduledTask }>(base(orgId), post(body));

export const updateSchedule = (orgId: string, id: string, body: ScheduleUpdateBody) =>
  apiFetch<{ task: ScheduledTask }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteSchedule = (orgId: string, id: string) =>
  apiFetch<void>(one(orgId, id), { method: "DELETE" });

export const pauseSchedule = (orgId: string, id: string) =>
  apiFetch<{ task: ScheduledTask }>(`${one(orgId, id)}/pause`, post({}));

export const resumeSchedule = (orgId: string, id: string) =>
  apiFetch<{ task: ScheduledTask }>(`${one(orgId, id)}/resume`, post({}));

/** Run now (`trial`: an attended run whose approvals become the task's grants). */
export const runSchedule = (orgId: string, id: string, trial: boolean) =>
  apiFetch<{ run: TaskRun }>(`${one(orgId, id)}/run`, post(trial ? { trial: true } : {}));

/** The task's latest runs, newest first. */
export const listScheduleRuns = (orgId: string, id: string, limit = RUNS_SHOWN) =>
  apiFetch<{ items: TaskRun[] }>(`${one(orgId, id)}/runs?limit=${limit}`);

export const listScheduleGrants = (orgId: string, id: string) =>
  apiFetch<{ items: ScheduledTaskGrant[] }>(`${one(orgId, id)}/grants`);

export const addScheduleGrants = (orgId: string, id: string, toolKeys: string[]) =>
  apiFetch<{ items: ScheduledTaskGrant[] }>(
    `${one(orgId, id)}/grants`,
    post({ grants: toolKeys.map((toolKey) => ({ toolKey })) }),
  );

export const removeScheduleGrant = (orgId: string, id: string, toolKey: string) =>
  apiFetch<void>(`${one(orgId, id)}/grants/${enc(toolKey)}`, { method: "DELETE" });

/** How many runs the task page lists. */
export const RUNS_SHOWN = 20;

// ---- schedule presets (spec §5: the UI offers presets that write cron) ----

/** A schedule as the form edits it. `time` is `HH:MM`; `at` is a local `YYYY-MM-DDTHH:MM`. */
export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "once"; at: string }
  | { kind: "custom"; expr: string };

export type PresetKind = SchedulePreset["kind"];

/** The minutes the hourly preset offers; another minute reads as a custom cron. */
export const HOURLY_MINUTES: readonly number[] = [0, 5, 10, 15, 20, 30, 45];
/** The days the monthly preset offers (every month has them); later days read as custom. */
export const MONTH_DAYS = 28;
export const PRESET_KINDS: readonly PresetKind[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "once",
  "custom",
];

const pad = (n: number) => String(n).padStart(2, "0");
const NUM = /^\d{1,2}$/;
const num = (s: string, min: number, max: number): number | null => {
  if (!NUM.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

/** `HH:MM` of a cron minute and hour field, or null when they are not plain numbers. */
function timeOf(minute: string, hour: string): string | null {
  const m = num(minute, 0, 59);
  const h = num(hour, 0, 23);
  return m === null || h === null ? null : `${pad(h)}:${pad(m)}`;
}

/** The preset a trigger reads as: one of the simple forms, else `custom` with the cron. */
export function presetOf(trigger: ScheduleTrigger | TriggerInput): SchedulePreset {
  if (trigger.kind === "once") return { kind: "once", at: trigger.at.slice(0, 16) };
  const expr = trigger.expr.trim();
  const f = expr.split(/\s+/);
  if (f.length === 5) {
    const [mi = "", h = "", dom = "", mon = "", dow = ""] = f;
    const minute = num(mi, 0, 59);
    if (
      minute !== null &&
      HOURLY_MINUTES.includes(minute) &&
      h === "*" &&
      dom === "*" &&
      mon === "*" &&
      dow === "*"
    ) {
      return { kind: "hourly", minute };
    }
    const time = timeOf(mi, h);
    if (time !== null && mon === "*") {
      if (dom === "*" && dow === "*") return { kind: "daily", time };
      if (dom === "*" && dow === "1-5") return { kind: "weekdays", time };
      const day = num(dow, 0, 7);
      if (dom === "*" && day !== null) return { kind: "weekly", day: day % 7, time };
      const date = num(dom, 1, MONTH_DAYS);
      if (date !== null && dow === "*") return { kind: "monthly", day: date, time };
    }
  }
  return { kind: "custom", expr };
}

/** `HH:MM` → [hour, minute] (00:00 for anything else). */
function hm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (m === null) return [0, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

/** The trigger a preset writes. */
export function triggerOf(p: SchedulePreset): TriggerInput {
  switch (p.kind) {
    case "once":
      return { kind: "once", at: p.at };
    case "custom":
      return { kind: "cron", expr: p.expr.trim() };
    case "hourly":
      return { kind: "cron", expr: `${p.minute} * * * *` };
    default: {
      const [h, m] = hm(p.time);
      const tail =
        p.kind === "daily"
          ? "* * *"
          : p.kind === "weekdays"
            ? "* * 1-5"
            : p.kind === "weekly"
              ? `* * ${p.day}`
              : `${p.day} * *`;
      return { kind: "cron", expr: `${m} ${h} ${tail}` };
    }
  }
}

/** Whether the preset can be sent (the kernel checks the cron and the time itself). */
export function presetValid(p: SchedulePreset): boolean {
  if (p.kind === "custom") return p.expr.trim().split(/\s+/).length === 5;
  if (p.kind === "once") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.at);
  return true;
}

/** A fresh preset of `kind`, keeping the time of `from` where it has one. */
export function switchPreset(from: SchedulePreset, kind: PresetKind): SchedulePreset {
  const time = "time" in from ? from.time : "09:00";
  switch (kind) {
    case "hourly":
      return { kind, minute: 0 };
    case "daily":
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, day: 1, time };
    case "monthly":
      return { kind, day: 1, time };
    case "once":
      return { kind, at: "" };
    case "custom":
      return { kind, expr: triggerOf(from).kind === "cron" ? cronText(from) : "0 9 * * *" };
  }
}

const cronText = (p: SchedulePreset): string => {
  const t = triggerOf(p);
  return t.kind === "cron" ? t.expr : "";
};

/** The words for a schedule (no zone): the message key under `schedules.when` and its values. */
export function scheduleWords(trigger: ScheduleTrigger | TriggerInput): {
  key: "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "once" | "cron";
  values: Record<string, string | number>;
} {
  const p = presetOf(trigger);
  switch (p.kind) {
    case "hourly":
      return { key: "hourly", values: { minute: pad(p.minute) } };
    case "daily":
    case "weekdays":
      return { key: p.kind, values: { time: p.time } };
    case "weekly":
      return { key: "weekly", values: { day: p.day, time: p.time } };
    case "monthly":
      return { key: "monthly", values: { day: p.day, time: p.time } };
    case "once":
      return { key: "once", values: { at: p.at.replace("T", " ") } };
    case "custom":
      return { key: "cron", values: { expr: p.expr } };
  }
}

/** The status a task shows: its state, or the pause's reason. */
export type ScheduleState = "active" | "ended" | `paused.${SchedulePauseReason}`;

export const scheduleState = (t: ScheduledTask): ScheduleState =>
  t.status === "paused" ? `paused.${t.pauseReason ?? "creator"}` : t.status;

/** The browser's IANA zone (sent on create; the kernel uses it only when the account has none). */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** `connection:<slug>`: a personal connector the run needed and the creator has not connected. */
export const connectionOf = (key: string): string | null =>
  key.startsWith("connection:") ? key.slice("connection:".length) : null;

/** A chat target's value in a select (and back). */
export const chatKey = (c: Pick<ScheduleChat, "connectionId" | "chatId" | "chatType">): string =>
  `${c.connectionId}\n${c.chatId}\n${c.chatType}`;

/** Tool keys typed one per line (commas and spaces split too), trimmed, without repeats. */
export function splitToolKeys(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter((k) => k !== ""),
    ),
  ];
}

/** `YYYY-MM-DD` of an instant in a zone (the date an expiry shows). */
export function dateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** The instant a task with an end date `YYYY-MM-DD` ends: the end of that day in its zone. */
export function endOfDayIn(date: string, timeZone: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59);
  // the zone's offset at that moment: its wall clock read back as UTC, minus the instant
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return new Date(guess - (wall - guess)).toISOString();
}
