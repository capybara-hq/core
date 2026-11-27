import type { Effort } from "./agents";
import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/**
 * The kernel's automations API (`packages/kernel/src/automations/automations.controller.ts`,
 * spec 2026-11-11-scheduled-tasks §10; only the fields the UI uses). Web code never imports
 * kernel code.
 */

/** One clause of an event trigger's filter (every clause must match the event's facts). */
export interface EventFilterClause {
  fact: string;
  op: "eq" | "in" | "contains";
  value: string | number | boolean | string[];
}

/**
 * A time trigger, or an event trigger (collaboration spec §4.1): events of `types` from the
 * extension `source`. An event automation has no zone and no next run time.
 */
export type AutomationTrigger =
  | { kind: "cron"; expr: string; timeZone: string }
  | { kind: "once"; at: string; timeZone: string }
  | { kind: "event"; source: string; types: string[]; filter: EventFilterClause[] };

/** The time triggers: the ones the schedule editor and the calendar read. */
export type AutomationTimeTrigger = Exclude<AutomationTrigger, { kind: "event" }>;

/**
 * `subject`: one conversation per event subject (collaboration spec §4.5); it needs an event
 * trigger, and `chat` needs a time one.
 */
export type AutomationMode = "new" | "conversation" | "chat" | "subject";

/** What a question asked in an unattended run does (`null` on an automation: the org's default). */
export type UnattendedAsk = "fail" | "wait";

export interface AutomationChat {
  connectionId: string;
  chatId: string;
  chatType: "dm" | "group";
}

export type AutomationStatus = "active" | "paused" | "ended";

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
export type AutomationPauseReason = (typeof PAUSE_REASONS)[number];

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
  "plugin_disabled",
  "unsupported_target",
  "task_deleted",
  "task_paused",
  "subject_rate",
] as const;
export type TaskRunSkipReason = (typeof SKIP_REASONS)[number];

export { EFFORTS as AUTOMATION_EFFORTS } from "./agents";
export type AutomationEffort = Effort;

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
  conversationId: string | null;
  chat: AutomationChat | null;
  /** Null: the agent's model. */
  model: ModelRef | null;
  /** Null: the agent's effort. */
  effort: string | null;
  deviceId: string | null;
  /** Null: the org's default. */
  unattendedAsk: UnattendedAsk | null;
  status: AutomationStatus;
  pauseReason: AutomationPauseReason | null;
  pausedBy: string | null;
  /** The next fire time, jitter included; null when not active (and for an event automation). */
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
export type AutomationListItem = Automation & { lastRun: TaskLastRun | null };

/** A chat a `chat` task can post into (`GET …/automations/chat-targets`). */
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
  | "fixed_ask"
  /** A network grant outside the org's allowlist: only an org admin can add the host. */
  | "needs_admin"
  /** A network grant the task's device cannot take (Docker mode or an older program). */
  | "device_refuses";

/** One of an agent's tools as the grant picker offers it (`GET …/automations/grantable-tools`). */
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
  /** The tick; null for an event run. */
  scheduledFor: string | null;
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
export interface AutomationGrant {
  toolKey: string;
  specHash: string;
  connectorId: string | null;
  /**
   * The tool changed since it was approved: the approval no longer applies (spec §7); null when
   * the kernel could not read the agent's tools just now. Always false for a domain.
   */
  stale?: boolean | null;
}

/** When a time task fires, before the zone is fixed. */
export type TimeTriggerInput = { kind: "cron"; expr: string } | { kind: "once"; at: string };

/** An event trigger as the body sends it (a missing filter keeps every event of the types). */
export type EventTriggerInput = {
  kind: "event";
  source: string;
  types: string[];
  filter?: EventFilterClause[];
};

/** The create / patch body's `trigger`. */
export type TriggerInput = TimeTriggerInput | EventTriggerInput;

export interface AutomationCreateBody {
  agentId: string;
  name: string;
  prompt: string;
  trigger: TriggerInput;
  /** The browser's zone: used only when the account has none. */
  timeZone?: string;
  mode: AutomationMode;
  conversationId?: string;
  chat?: AutomationChat;
  model?: ModelRef;
  effort?: AutomationEffort;
  expiresAt?: string | null;
  /** Tools by key, domains as `network:<host>` (one exact host). */
  grants?: { toolKey: string }[];
  /** Absent or null: the org's default. */
  unattendedAsk?: UnattendedAsk | null;
}

export interface AutomationUpdateBody {
  agentId?: string;
  name?: string;
  prompt?: string;
  trigger?: TriggerInput;
  timeZone?: string;
  mode?: AutomationMode;
  conversationId?: string | null;
  chat?: AutomationChat | null;
  model?: ModelRef | null;
  effort?: AutomationEffort | null;
  expiresAt?: string | null;
  unattendedAsk?: UnattendedAsk | null;
}

/** The org's automations settings (`orgs.settings.automations`, spec §9). */
export interface AutomationsSettings {
  enabled: boolean;
  minIntervalMinutes: number;
  maxTasksPerMember: number;
  maxTasksPerOrg: number;
  maxRunsPerHour: number;
  defaultExpiryDays: number | null;
  catchUpWindowMinutes: number;
  unattendedAsk: "fail" | "wait";
  pauseAfterFailures: number;
  /** Event automations: the chain depth past which an event is not dispatched. */
  maxEventDepth: number;
  /** Event automations: the window, in seconds, that coalesces one subject's events. */
  coalesceSeconds: number;
  /** Event automations: up to this many runs of one automation for one subject per hour. */
  maxEventRunsPerSubjectPerHour: number;
  /** The trigger sources (extension names) whose events fire no automation of the org. */
  eventSourcesOff: string[];
  forbiddenTools: string[];
  /**
   * In responses only: the stored list cannot be read (`forbiddenTools` reads `[]`); unattended
   * runs fail until an org admin saves the list again.
   */
  forbiddenToolsUnreadable?: true;
}

/** The defaults of spec §9. */
export const AUTOMATION_SETTINGS_DEFAULTS: AutomationsSettings = {
  enabled: true,
  minIntervalMinutes: 60,
  maxTasksPerMember: 20,
  maxTasksPerOrg: 200,
  maxRunsPerHour: 60,
  defaultExpiryDays: null,
  catchUpWindowMinutes: 60,
  unattendedAsk: "fail",
  pauseAfterFailures: 5,
  maxEventDepth: 8,
  coalesceSeconds: 30,
  maxEventRunsPerSubjectPerHour: 12,
  eventSourcesOff: [],
  forbiddenTools: [],
};

const enc = encodeURIComponent;
const base = (orgId: string) => `/api/v1/orgs/${enc(orgId)}/automations`;
const one = (orgId: string, id: string) => `${base(orgId)}/${enc(id)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** My tasks; `all`: every task of the org (org admins). */
export const listAutomations = (orgId: string, all = false) =>
  apiFetch<{ items: AutomationListItem[] }>(`${base(orgId)}${all ? "?all=true" : ""}`);

/** My tasks that post into a conversation (its side panel). */
export const listConversationAutomations = (orgId: string, conversationId: string) =>
  apiFetch<{ items: AutomationListItem[] }>(`${base(orgId)}?conversationId=${enc(conversationId)}`);

/** The chats a `chat` task of mine can post into. */
export const listChatTargets = (orgId: string) =>
  apiFetch<{ items: ChatTarget[] }>(`${base(orgId)}/chat-targets`);

/** One fact of an event type: its value type and whether a filter may name it. */
export interface EventFactDecl {
  type: "string" | "number" | "boolean" | "string[]";
  name: { zh: string; en: string };
  filterable: boolean;
}

/** One event type of a trigger source. A directed one cannot trigger an automation. */
export interface EventTypeDecl {
  type: string;
  name: { zh: string; en: string };
  directed: boolean;
  facts: Record<string, EventFactDecl>;
}

/** A trigger source that serves the org (`GET …/automations/event-sources`). */
export interface EventSource {
  source: string;
  name: { zh: string; en: string };
  events: EventTypeDecl[];
}

/** The trigger sources of the org with their event declarations (the event trigger's pickers). */
export const listEventSources = (orgId: string) =>
  apiFetch<{ items: EventSource[] }>(`${base(orgId)}/event-sources`);

/** An agent's tools, each grantable in advance or why not. */
export const listGrantableTools = (orgId: string, agentId: string) =>
  apiFetch<{ items: GrantableTool[] }>(`${base(orgId)}/grantable-tools?agentId=${enc(agentId)}`);

export const getAutomation = (orgId: string, id: string) =>
  apiFetch<{ task: Automation }>(one(orgId, id));

export const createAutomation = (orgId: string, body: AutomationCreateBody) =>
  apiFetch<{ task: Automation }>(base(orgId), post(body));

export const updateAutomation = (orgId: string, id: string, body: AutomationUpdateBody) =>
  apiFetch<{ task: Automation }>(one(orgId, id), {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteAutomation = (orgId: string, id: string) =>
  apiFetch<void>(one(orgId, id), { method: "DELETE" });

export const pauseAutomation = (orgId: string, id: string) =>
  apiFetch<{ task: Automation }>(`${one(orgId, id)}/pause`, post({}));

export const resumeAutomation = (orgId: string, id: string) =>
  apiFetch<{ task: Automation }>(`${one(orgId, id)}/resume`, post({}));

/** Run now (`trial`: an attended run whose approvals become the task's grants). */
export const runAutomation = (orgId: string, id: string, trial: boolean) =>
  apiFetch<{ run: TaskRun }>(`${one(orgId, id)}/run`, post(trial ? { trial: true } : {}));

/** The task's latest runs, newest first. */
export const listAutomationRuns = (orgId: string, id: string, limit = RUNS_SHOWN) =>
  apiFetch<{ items: TaskRun[] }>(`${one(orgId, id)}/runs?limit=${limit}`);

export const listAutomationGrants = (orgId: string, id: string) =>
  apiFetch<{ items: AutomationGrant[] }>(`${one(orgId, id)}/grants`);

export const addAutomationGrants = (orgId: string, id: string, toolKeys: string[]) =>
  apiFetch<{ items: AutomationGrant[] }>(
    `${one(orgId, id)}/grants`,
    post({ grants: toolKeys.map((toolKey) => ({ toolKey })) }),
  );

export const removeAutomationGrant = (orgId: string, id: string, toolKey: string) =>
  apiFetch<void>(`${one(orgId, id)}/grants/${enc(toolKey)}`, { method: "DELETE" });

// ---- the calendar (calendar spec §5.1: `GET …/automations/calendar`) ----

/** A task an item of the calendar names. */
export interface CalendarTask {
  id: string;
  name: string;
  agentId: string;
  accountId: string;
  status: AutomationStatus;
  pauseReason: AutomationPauseReason | null;
  trigger: AutomationTrigger;
  mode: AutomationMode;
  jitterSeconds: number;
  nextRunAt: string | null;
}

/** A recorded run or a planned occurrence. */
export type CalendarItem =
  | {
      kind: "run";
      taskId: string;
      /** The task run's id. */
      id: string;
      /** The tick (before jitter), or the request time of a manual run. */
      scheduledFor: string;
      firedAt: string | null;
      status: TaskRunStatus;
      skipReason: TaskRunSkipReason | null;
      trial: boolean;
      manual: boolean;
      /** Null for another member's run (an admin's org-wide view), as `error` and `missingGrants`. */
      conversationId: string | null;
      error: string | null;
      missingGrants: number | null;
    }
  | {
      kind: "occurrence";
      taskId: string;
      /** The tick, before jitter. */
      scheduledFor: string;
      /** When it fires: the tick plus the task's jitter. */
      at: string;
    };

/** A dense task's items of one viewer-local day, summarized. */
export interface CalendarCollapsed {
  taskId: string;
  /** YYYY-MM-DD in the request's zone. */
  day: string;
  count: number;
  upcoming: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  first: string;
  last: string;
}

export interface CalendarAnswer {
  tasks: CalendarTask[];
  items: CalendarItem[];
  collapsed: CalendarCollapsed[];
  /** Nothing is returned after it (42 days ahead, or where a limit cut the range). */
  horizon: string;
  /** A limit cut the range at a whole day: the days from `horizon` on are not loaded. */
  truncated: boolean;
}

export interface CalendarParams {
  /** ISO instants, `from < to`, at most 43 days (2 with `taskId`). */
  from: string;
  to: string;
  /** The viewer's IANA zone (the local days dense tasks are counted in). */
  timeZone: string;
  /** Every task of the org (org admins). */
  all: boolean;
  /** Only this task, never collapsed (the run panel's day list). */
  taskId?: string;
}

/** The runs and planned occurrences of a range. */
export const getAutomationCalendar = (orgId: string, p: CalendarParams) => {
  const q = new URLSearchParams({ from: p.from, to: p.to, timeZone: p.timeZone });
  if (p.all) q.set("all", "true");
  if (p.taskId !== undefined) q.set("taskId", p.taskId);
  return apiFetch<CalendarAnswer>(`${base(orgId)}/calendar?${q}`);
};

/** How many runs the task page lists. */
export const RUNS_SHOWN = 20;

// ---- schedule presets (spec §5: the UI offers presets that write cron) ----

/** A schedule as the form edits it. `time` is `HH:MM`; `at` is a local `YYYY-MM-DDTHH:MM`. */
export type AutomationPreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "once"; at: string }
  | { kind: "custom"; expr: string };

export type PresetKind = AutomationPreset["kind"];

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

/** A trigger's zone; null for an event trigger (it has none). */
export const zoneOf = (trigger: AutomationTrigger): string | null =>
  trigger.kind === "event" ? null : trigger.timeZone;

/** The preset a time trigger reads as: one of the simple forms, else `custom` with the cron. */
export function presetOf(trigger: AutomationTimeTrigger | TimeTriggerInput): AutomationPreset {
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
export function triggerOf(p: AutomationPreset): TimeTriggerInput {
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
export function presetValid(p: AutomationPreset): boolean {
  if (p.kind === "custom") return p.expr.trim().split(/\s+/).length === 5;
  if (p.kind === "once") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.at);
  return true;
}

/** A fresh preset of `kind`, keeping the time of `from` where it has one. */
export function switchPreset(from: AutomationPreset, kind: PresetKind): AutomationPreset {
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

const cronText = (p: AutomationPreset): string => {
  const t = triggerOf(p);
  return t.kind === "cron" ? t.expr : "";
};

/** The words for a schedule (no zone): the message key under `automations.when` and its values. */
export function automationWords(trigger: AutomationTrigger | TriggerInput): {
  key: "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "once" | "cron" | "event";
  values: Record<string, string | number>;
} {
  if (trigger.kind === "event") {
    return { key: "event", values: { source: trigger.source, types: trigger.types.join(", ") } };
  }
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

// ---- event triggers (collaboration spec §4.1, §4.3: the form builds its filter from the facts) ----

/** One clause of the filter as the form edits it: the value as text, the fact's type kept. */
export interface FilterRowDraft {
  key: string;
  fact: string;
  /** The fact's declared type: it decides which operators and which value parse apply. */
  factType: EventFactDecl["type"];
  op: EventFilterClause["op"];
  value: string;
}

/** An event trigger as the form edits it. */
export interface EventDraft {
  source: string;
  types: string[];
  filter: FilterRowDraft[];
}

export const emptyEventDraft = (): EventDraft => ({ source: "", types: [], filter: [] });

/** A fact a filter row may name: filterable, declared by every selected type with one type. */
export interface FilterableFact {
  fact: string;
  name: { zh: string; en: string };
  type: EventFactDecl["type"];
}

/** The event types of a source a person may select: not the directed ones. */
export const selectableTypes = (source: EventSource | undefined): EventTypeDecl[] =>
  (source?.events ?? []).filter((e) => !e.directed);

/** The facts a filter may name for the selected `types` of `source`, in declaration order. */
export function filterableFacts(
  source: EventSource | undefined,
  types: string[],
): FilterableFact[] {
  const decls = selectableTypes(source).filter((e) => types.includes(e.type));
  const first = decls[0];
  if (first === undefined) return [];
  return Object.entries(first.facts).flatMap(([fact, f]) =>
    f.filterable &&
    decls.every((d) => d.facts[fact]?.filterable === true && d.facts[fact]?.type === f.type)
      ? [{ fact, name: f.name, type: f.type }]
      : [],
  );
}

/** The operators that fit a fact type (the kernel's `validateFilter`). */
export const opsOf = (type: EventFactDecl["type"]): EventFilterClause["op"][] =>
  type === "string" ? ["eq", "in"] : type === "string[]" ? ["contains"] : ["eq"];

/** Splits a typed list: commas or new lines, trimmed, without empty entries or repeats. */
export const splitList = (text: string): string[] => [
  ...new Set(
    text
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v !== ""),
  ),
];

/** The clause a row writes; null while its value is empty or not of the fact's type. */
export function clauseOf(row: FilterRowDraft): EventFilterClause | null {
  const text = row.value.trim();
  if (row.fact === "" || text === "") return null;
  if (row.op === "in") {
    const list = splitList(row.value);
    return list.length === 0 ? null : { fact: row.fact, op: "in", value: list };
  }
  if (row.op === "contains") return { fact: row.fact, op: "contains", value: text };
  if (row.factType === "number") {
    return /^-?\d+(\.\d+)?$/.test(text) ? { fact: row.fact, op: "eq", value: Number(text) } : null;
  }
  if (row.factType === "boolean") {
    return text === "true" || text === "false"
      ? { fact: row.fact, op: "eq", value: text === "true" }
      : null;
  }
  return { fact: row.fact, op: "eq", value: text };
}

/** Whether the event part can be sent (the kernel checks the declarations). */
export const eventDraftValid = (e: EventDraft): boolean =>
  e.source !== "" && e.types.length > 0 && e.filter.every((r) => clauseOf(r) !== null);

/** The event trigger a draft writes. */
export function eventBodyOf(e: EventDraft): EventTriggerInput {
  const filter = e.filter.flatMap((r) => {
    const c = clauseOf(r);
    return c === null ? [] : [c];
  });
  return { kind: "event", source: e.source, types: e.types, filter };
}

let rowSeq = 0;
/** A new row's key (stable across edits). */
export const newRowKey = (): string => `row-${++rowSeq}`;

/** A row for a saved clause; the fact's type is read back from the operator and the value. */
function rowOf(c: EventFilterClause): FilterRowDraft {
  const factType: EventFactDecl["type"] =
    c.op === "contains"
      ? "string[]"
      : typeof c.value === "boolean"
        ? "boolean"
        : typeof c.value === "number"
          ? "number"
          : "string";
  return {
    key: newRowKey(),
    fact: c.fact,
    factType,
    op: c.op,
    value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value),
  };
}

/** The draft of a saved event trigger. */
export const eventDraftOf = (t: Extract<AutomationTrigger, { kind: "event" }>): EventDraft => ({
  source: t.source,
  types: t.types,
  filter: t.filter.map(rowOf),
});

/** The status a task shows: its state, or the pause's reason. */
export type AutomationState = "active" | "ended" | `paused.${AutomationPauseReason}`;

export const automationState = (t: Pick<Automation, "status" | "pauseReason">): AutomationState =>
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
export const chatKey = (c: Pick<AutomationChat, "connectionId" | "chatId" | "chatType">): string =>
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
