import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import type { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import type { OrgRole } from "../../orgs/roles.js";
import { readScheduleSettings } from "../../schedules/effective-settings.js";
import { nextTick } from "../../schedules/schedule-math.js";
import type {
  ChatTarget,
  ScheduledTasksService,
  TriggerInput,
  UpdateTaskInput,
} from "../../schedules/scheduled-tasks.service.js";
import { ScheduledTaskStore } from "../../schedules/store.js";
import type {
  ScheduleChat,
  ScheduledTask,
  ScheduleMode,
  ScheduleTrigger,
} from "../../schedules/types.js";
import { BUILTIN } from "../builtin-names.js";
import type {
  BuiltinCallContext,
  BuiltinTool,
  CallPolicy,
  CallPolicyContext,
  ToolListingScope,
} from "../registry.js";
import { localTime } from "./current-time.js";
import { clip, display } from "./sandbox/common.js";

/**
 * The schedule builtins (scheduled tasks spec §11): `ScheduleCreate`, `ScheduleUpdate`,
 * `ScheduleList`, `ScheduleTargets` and `ScheduleDelete` manage the scheduled tasks of the run's
 * trigger account through the same service as the HTTP routes (`ScheduledTasksService`), so the
 * org's limits and the grant rules apply unchanged.
 *
 * - `ScheduleCreate` / `ScheduleUpdate` are fixed asks (R3, `R3_FIXED_ASK_TOOL_KEYS`) with a
 *   per-call policy that never remembers: every call asks, no grant (conversation, always or task)
 *   covers it, and an unattended run in `fail` mode is refused. The approval card's summary is
 *   rendered here, by the kernel, from the input and the stored task: name, schedule in words with
 *   its zone, where runs go and the approved tools (an update shows what changes).
 * - The approved tools of a task are exactly the `approvedTools` of the approved input: create
 *   grants that list, and an update that passes it replaces the task's grants with it (the card
 *   lists the full new set), so nothing beyond what the person saw is ever granted.
 * - `ScheduleList` (allow) lists the person's own tasks; `ScheduleTargets` (allow) lists the IM
 *   chats they can deliver to (the service's `chatTargets`, the same data as the route);
 *   `ScheduleDelete` (allow; deleting only narrows) deletes only the person's own task, even when
 *   they are an org admin.
 * - `mode: "here"`: a `chat` task for this conversation's IM direct chat when the conversation is
 *   delivered to one (`channel_deliveries`) and is the live DM thread of the person
 *   (`channel_threads`), else a `conversation` task for this conversation. `mode: "chat"` posts into
 *   the IM chat named by `chat`. The zone is the run's (`run_context`, else the org's, else UTC).
 */

/** The task service as the tools use it (bound at start; null when not loaded here). */
export type ScheduleService = Pick<
  ScheduledTasksService,
  "create" | "update" | "list" | "remove" | "addGrants" | "removeGrant" | "chatTargets"
>;

/**
 * Where the schedule tools find the task service: a registration port. `SchedulesModule` imports
 * `ToolsModule` (its grants resolve the agent's tools through `ToolRegistry`, which lists these
 * builtins), so the service cannot be injected into the builtins; `SchedulesModule` binds it here
 * from `onModuleInit` instead, as the domain operations register into `PlatformOperations`. Null
 * until bound (an application without `SchedulesModule`).
 */
@Injectable()
export class ScheduleToolsPort {
  private service: ScheduleService | null = null;

  bind(service: ScheduleService): void {
    this.service = service;
  }

  get(): ScheduleService | null {
    return this.service;
  }
}

export interface ScheduleToolsDeps {
  /** The kernel-schema handle of the current context. */
  db: () => KernelSchemaDb;
  config: Pick<KernelConfigService, "get">;
  store: Pick<ScheduledTaskStore, "getTask" | "listGrants">;
  /** The task service, or null when this application does not load it. */
  service: () => ScheduleService | null;
  /** `ScheduleUpdate`'s write (its field change and grant changes commit together). */
  updates: Pick<ScheduleUpdates, "apply">;
  /** The conversation's zone: its latest `run_context`, else the org's, else UTC. */
  timeZoneOf: (orgId: string, conversationId: string) => Promise<string>;
  /** The clock (epoch ms), for the next run shown on cards and lists. */
  now: () => number;
}

const NAME_MAX = 200;
const PROMPT_MAX = 20_000;
const TOOLS_MAX = 50;
/** How much of a new prompt an update's card shows. */
const PROMPT_SHOWN = 300;

const TOOL_KEYS_SCHEMA = {
  type: "array",
  maxItems: TOOLS_MAX,
  items: { type: "string", minLength: 1, maxLength: 200 },
  description:
    "Tool keys the task may use without asking when it runs unattended, e.g. " +
    '["WebSearch", "mcp__docs__search"]. Only tools this agent has now; tools that always ask a ' +
    "person (ScheduleCreate, ScheduleUpdate, ...) cannot be listed. A run that needs a tool not listed " +
    "fails that call. The person sees and approves this list.",
} as const;

const CRON_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  description:
    "A repeating schedule: a 5-field cron expression (minute hour day-of-month month " +
    'day-of-week) in the user\'s time zone, e.g. "0 9 * * 1-5" for 09:00 on weekdays or ' +
    '"30 8 * * *" for 08:30 every day. The organization sets a minimum interval (usually one ' +
    "hour). Pass cron or runAt, not both.",
} as const;

const RUN_AT_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 40,
  description:
    "A single run: a local date-time YYYY-MM-DDTHH:mm in the user's time zone, without an " +
    'offset, e.g. "2026-12-01T15:00". Call CurrentTime first to know the date and time now. ' +
    "Pass cron or runAt, not both.",
} as const;

const MODE_SCHEMA = {
  type: "string",
  enum: ["new", "here", "chat"],
  description:
    '"new": every run starts a new conversation with this agent. "here": every run posts the ' +
    "prompt into this conversation (in an IM direct chat: the chat's current conversation), " +
    'e.g. for "check this again at 3 pm". "chat": every run posts into the IM chat named by ' +
    "chat.",
} as const;

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    connectionId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "The id of the active channel connection that delivers to the chat.",
    },
    chatId: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "The chat's id within that connection, e.g. a DM's user id or a group's id.",
    },
    chatType: {
      type: "string",
      enum: ["dm", "group"],
      description:
        'The kind of chat: "dm" (the default) or "group". A group needs a channel with threads.',
    },
    agentId: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description:
        "The agent the chat belongs to; defaults to this run's agent. A chat target must use " +
        "the connection's agent.",
    },
  },
  required: ["connectionId", "chatId"],
  additionalProperties: false,
} as const;

const CREATE_SPEC: ToolSpec = {
  name: BUILTIN.ScheduleCreate,
  description:
    "Create a scheduled task for the user: this agent runs the prompt on a schedule (cron) or " +
    "once at a time (runAt), in the user's time zone, acting as the user. Each run starts a new " +
    "conversation, posts into this conversation, or posts into an IM chat the user names with " +
    'chat. Use it when the user asks for something recurring or later ("every weekday at 9 ' +
    'send me a brief", "remind me at 3 pm"). Every call asks the user to approve the whole task ' +
    "first. Runs happen without the user present: write the prompt so it stands on its own, and " +
    "list in approvedTools the tools a run needs without asking. Do not use it for work to do now.",
  keyArgs: ["name"],
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: NAME_MAX,
        description: 'A short name for the task, e.g. "Morning brief".',
      },
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: PROMPT_MAX,
        description:
          "The message each run starts with, written as the user's instruction to this agent.",
      },
      cron: CRON_SCHEMA,
      runAt: RUN_AT_SCHEMA,
      mode: MODE_SCHEMA,
      chat: {
        ...CHAT_SCHEMA,
        description: 'For mode "chat": the IM chat every run posts into.',
      },
      approvedTools: TOOL_KEYS_SCHEMA,
    },
    required: ["name", "prompt", "mode"],
    additionalProperties: false,
  },
};

const UPDATE_SPEC: ToolSpec = {
  name: BUILTIN.ScheduleUpdate,
  description:
    "Change one of the user's scheduled tasks: its name, prompt, schedule, where it runs (a new " +
    "conversation, this conversation or an IM chat, and the agent) or its approved tools. Pass " +
    "the task id and only the fields to change; approvedTools replaces the whole list. Every " +
    "call asks the user to approve the change first. It does not pause, resume or delete a task.",
  keyArgs: ["id"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 100, description: "The task id." },
      name: { type: "string", minLength: 1, maxLength: NAME_MAX, description: "A new name." },
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: PROMPT_MAX,
        description: "A new prompt for every later run.",
      },
      cron: CRON_SCHEMA,
      runAt: RUN_AT_SCHEMA,
      mode: MODE_SCHEMA,
      chat: {
        ...CHAT_SCHEMA,
        description: 'For mode "chat": the IM chat every run posts into; replaces the target.',
      },
      approvedTools: {
        ...TOOL_KEYS_SCHEMA,
        description: `${TOOL_KEYS_SCHEMA.description} Replaces the task's whole list; pass [] to remove every approved tool, omit it to keep the list.`,
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const LIST_SPEC: ToolSpec = {
  name: BUILTIN.ScheduleList,
  description:
    "List the user's scheduled tasks in this organization: id, name, schedule with its time " +
    "zone, status, next run and where runs go. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const TARGETS_SPEC: ToolSpec = {
  name: BUILTIN.ScheduleTargets,
  description:
    "List the IM chats scheduled task runs can be delivered to for the user in this " +
    "organization: each chat's connection id, chat id, chat type and the connection's agent id, " +
    "with a label naming the connection. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const DELETE_SPEC: ToolSpec = {
  name: BUILTIN.ScheduleDelete,
  description:
    "Delete one of the user's scheduled tasks for good: it never runs again; past conversations " +
    "stay. Use it when the user asks to stop or remove a task. Only the user's own tasks can be " +
    "deleted.",
  keyArgs: ["id"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 100, description: "The task id." },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const ToolKeys = z.array(z.string().min(1).max(200)).max(TOOLS_MAX);
const Mode = z.enum(["new", "here", "chat"]);
const Chat = z
  .object({
    connectionId: z.string().min(1).max(100),
    chatId: z.string().min(1).max(500),
    chatType: z.enum(["dm", "group"]).optional(),
    agentId: z.string().min(1).max(100).optional(),
  })
  .strict();
type ChatInput = z.infer<typeof Chat>;

const CreateInput = z
  .object({
    name: z.string().min(1).max(NAME_MAX),
    prompt: z.string().min(1).max(PROMPT_MAX),
    cron: z.string().min(1).max(100).optional(),
    runAt: z.string().min(1).max(40).optional(),
    mode: Mode,
    chat: Chat.optional(),
    approvedTools: ToolKeys.optional(),
  })
  .strict();
type CreateInput = z.infer<typeof CreateInput>;

const UpdateInput = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(NAME_MAX).optional(),
    prompt: z.string().min(1).max(PROMPT_MAX).optional(),
    cron: z.string().min(1).max(100).optional(),
    runAt: z.string().min(1).max(40).optional(),
    mode: Mode.optional(),
    chat: Chat.optional(),
    approvedTools: ToolKeys.optional(),
  })
  .strict();
type UpdateInput = z.infer<typeof UpdateInput>;

const IdInput = z.object({ id: z.string().min(1).max(100) }).strict();

// ---- model-facing texts (English, actionable) ----

const INVALID_CREATE_TEXT =
  "Invalid input; pass name, prompt, mode (new, here or chat), exactly one of cron or runAt, " +
  "chat with mode chat (connectionId, chatId, chatType, agentId), and optionally approvedTools " +
  "as an array of tool keys.";
const INVALID_UPDATE_TEXT =
  "Invalid input; pass the task id and the fields to change (name, prompt, cron or runAt, mode, " +
  "chat, approvedTools).";
const INVALID_ID_TEXT = "Invalid input; pass the task id from ScheduleList.";
const ONE_TRIGGER_TEXT =
  "Pass exactly one of cron (a repeating schedule) or runAt (a single run), not both and not neither.";
const BOTH_TRIGGERS_TEXT =
  "Pass at most one of cron or runAt: cron makes the task repeat, runAt makes it run once.";
const NOTHING_TO_UPDATE_TEXT =
  "Nothing to change; pass at least one of name, prompt, cron, runAt, mode, chat or " +
  "approvedTools with the id.";
const CHAT_NEEDS_CHAT_TEXT =
  'mode "chat" needs a chat; pass chat with connectionId and chatId (and optionally chatType and agentId).';
const CHAT_ONLY_TEXT = 'chat applies only to mode "chat"; pass mode "chat" with it, or omit it.';
export const SCHEDULES_UNAVAILABLE_TEXT =
  "Scheduled tasks are not available on this server; ask the user to manage the task on the scheduled tasks page instead.";
export const SCHEDULES_OFF_TEXT =
  "Scheduled tasks are turned off in this organization; ask an org admin to turn them on.";

/** The card recomputed at run time differs from the one the person approved. */
export const cardChangedText = (tool: string): string =>
  `The task's time zone, target, tools or current settings changed after the user approved this ${tool} call, so nothing was changed; call ${tool} again so the user can approve the current version.`;
export const NOT_A_MEMBER_TEXT =
  "The user is no longer a member of this organization, so their scheduled tasks cannot be managed here; ask them to check their membership.";

/** No task with that id is the person's own (missing, deleted, or another member's). */
export const notYoursText = (id: string): string =>
  `No scheduled task with id ${clip(id, 100)} is the user's own; call ScheduleList to see the ids of the user's tasks.`;

/** The service's refusal as an actionable English tool error. */
export function scheduleErrorText(e: ApiError, ctx: { id?: string; zone?: string }): string {
  const m = e.message.replace(/[.\s]+$/, "");
  switch (e.code) {
    case "schedule.not_found":
    case "schedule.forbidden":
      return notYoursText(ctx.id ?? "");
    case "schedule.disabled":
      return SCHEDULES_OFF_TEXT;
    case "schedule.limit_reached":
      return `${m}. Call ScheduleList and ask the user which task to delete with ScheduleDelete.`;
    case "schedule.interval_too_short":
      return `${m}. Use a less frequent cron expression, or ask an org admin to lower the minimum interval.`;
    case "schedule.invalid_cron":
      return `${m}. Pass 5 fields (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5" for 09:00 on weekdays.`;
    case "schedule.invalid_once_time":
      return "runAt is not a local date-time; pass YYYY-MM-DDTHH:mm in the user's time zone without an offset, e.g. 2026-12-01T09:00.";
    case "schedule.once_in_past":
      return `runAt is not in the future in the user's time zone (${ctx.zone ?? "UTC"}); call CurrentTime and pass a later time.`;
    case "schedule.invalid_time_zone":
      return `${m}. Ask the user to set their time zone in their profile, then retry.`;
    case "schedule.target_invalid":
      return `${m}. Fix the target and retry, or use mode "new" to start a new conversation for every run instead.`;
    case "schedule.grant_not_allowed":
      return `${m}. Remove it from approvedTools and call again.`;
    case "forbidden":
      return "The user's role in this organization cannot manage scheduled tasks (guests cannot); ask an org admin.";
    case "conflict":
      return `${m}. Check the task with ScheduleList before trying again.`;
    default:
      return `${m}. Check the arguments and retry.`;
  }
}

// ---- words: schedules, targets, tools (the cards and results) ----

type Words = { zh: string; en: string };

const pad2 = (n: number) => String(n).padStart(2, "0");
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const INT = /^\d{1,2}$/;

/** A trigger in words, its zone included; an unusual cron reads as the expression itself. */
export function scheduleWords(t: ScheduleTrigger): Words {
  const zone = t.timeZone;
  if (t.kind === "once") {
    const at = t.at.replace("T", " ").slice(0, 16);
    return { zh: `仅一次，${at}（${zone}）`, en: `once at ${at} (${zone})` };
  }
  const f = t.expr.trim().split(/\s+/);
  const [mi = "", h = "", dom = "", mon = "", dow = ""] = f;
  const plain = f.length === 5 && INT.test(mi) && Number(mi) < 60;
  const atTime = INT.test(h) && Number(h) < 24 ? `${pad2(Number(h))}:${pad2(Number(mi))}` : null;
  let w: Words | null = null;
  if (plain && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    w = { zh: `每小时第 ${Number(mi)} 分`, en: `every hour at minute ${Number(mi)}` };
  } else if (plain && atTime !== null && mon === "*") {
    if (dom === "*" && dow === "*") w = { zh: `每天 ${atTime}`, en: `every day at ${atTime}` };
    else if (dom === "*" && dow === "1-5") {
      w = { zh: `每个工作日 ${atTime}`, en: `every weekday at ${atTime}` };
    } else if (dom === "*" && /^[0-7]$/.test(dow)) {
      const d = Number(dow) % 7;
      w = { zh: `每${DAYS_ZH[d]} ${atTime}`, en: `every ${DAYS_EN[d]} at ${atTime}` };
    } else if (dow === "*" && INT.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
      w = {
        zh: `每月 ${Number(dom)} 日 ${atTime}`,
        en: `on day ${Number(dom)} of every month at ${atTime}`,
      };
    }
  }
  const expr = f.join(" ");
  const out = w ?? { zh: `按 cron「${expr}」`, en: `on the cron schedule "${expr}"` };
  return { zh: `${out.zh}（${zone}）`, en: `${out.en} (${zone})` };
}

/** The next fire time in the trigger's zone, `YYYY-MM-DD HH:mm`, or null when there is none. */
function nextRunWords(t: ScheduleTrigger, now: number): string | null {
  const next = nextTick(t, new Date(now));
  return next === null ? null : localTime(next, t.timeZone).local.slice(0, 16).replace("T", " ");
}

/** Where a task's runs go, resolved for a card or a result. */
export type Target =
  | { mode: "new" }
  | { mode: "conversation"; conversationId: string }
  | { mode: "chat"; chat: ScheduleChat; connectionName: string };

function targetWords(t: Target, currentConversationId?: string): Words {
  if (t.mode === "new") return { zh: "每次运行新建对话", en: "a new conversation for every run" };
  if (t.mode === "chat") {
    const n = clip(t.connectionName, 60);
    return t.chat.chatType === "group"
      ? { zh: `${n} 的群聊`, en: `the group chat on ${n}` }
      : { zh: `${n} 的私聊`, en: `the direct chat on ${n}` };
  }
  return t.conversationId === currentConversationId
    ? { zh: "当前对话", en: "this conversation" }
    : { zh: `对话 ${t.conversationId}`, en: `conversation ${t.conversationId}` };
}

function toolsWords(keys: readonly string[]): Words {
  return keys.length === 0
    ? { zh: "无", en: "none" }
    : { zh: keys.join("、"), en: keys.join(", ") };
}

/** The `chat` input with its default kind (`dm`). */
const normalizedChat = (chat: ChatInput): ScheduleChat => ({
  connectionId: chat.connectionId,
  chatId: chat.chatId,
  chatType: chat.chatType ?? "dm",
});

/** A chat target with its connection's name for the words. */
async function chatTargetOf(db: KernelSchemaDb, chat: ScheduleChat): Promise<Target> {
  const c = await db
    .selectFrom("channel_connections")
    .select("name")
    .where("id", "=", chat.connectionId)
    .executeTakeFirst();
  return { mode: "chat", chat, connectionName: c?.name ?? chat.connectionId };
}

/** A stored task's target; a chat's connection name is read for the words. */
async function storedTarget(db: KernelSchemaDb, task: ScheduledTask): Promise<Target> {
  if (task.mode === "chat" && task.chat !== null) return chatTargetOf(db, task.chat);
  if (task.mode === "conversation" && task.conversationId !== null) {
    return { mode: "conversation", conversationId: task.conversationId };
  }
  return { mode: "new" };
}

/**
 * `mode: "here"` (spec §8): the conversation's IM direct chat when the conversation is delivered
 * to a chat and is the person's live DM thread there, else this conversation.
 */
export async function hereTarget(
  db: KernelSchemaDb,
  orgId: string,
  accountId: string,
  conversationId: string,
): Promise<Target> {
  const dm = await db
    .selectFrom("channel_threads as t")
    .innerJoin("channel_deliveries as d", (j) =>
      j
        .onRef("d.conversation_id", "=", "t.conversation_id")
        .onRef("d.connection_id", "=", "t.connection_id"),
    )
    .innerJoin("channel_connections as c", "c.id", "t.connection_id")
    .select(["t.connection_id", "t.chat_id", "c.name"])
    .where("t.conversation_id", "=", conversationId)
    .where("t.account_id", "=", accountId)
    .where("t.archived_at", "is", null)
    .where("t.thread_key", "like", "dm:%")
    .where("c.org_id", "=", orgId)
    .where("c.deleted_at", "is", null)
    .executeTakeFirst();
  if (dm) {
    return {
      mode: "chat",
      chat: { connectionId: dm.connection_id, chatId: dm.chat_id, chatType: "dm" },
      connectionName: dm.name,
    };
  }
  return { mode: "conversation", conversationId };
}

const targetFields = (
  t: Target,
): { mode: ScheduleMode; conversationId?: string; chat?: ScheduleChat } =>
  t.mode === "chat"
    ? { mode: "chat", chat: t.chat }
    : t.mode === "conversation"
      ? { mode: "conversation", conversationId: t.conversationId }
      : { mode: "new" };

const sameTarget = (a: Target, b: Target): boolean =>
  a.mode === b.mode &&
  (a.mode !== "conversation" ||
    a.conversationId === (b as Extract<Target, { mode: "conversation" }>).conversationId) &&
  (a.mode !== "chat" ||
    (a.chat.connectionId === (b as Extract<Target, { mode: "chat" }>).chat.connectionId &&
      a.chat.chatId === (b as Extract<Target, { mode: "chat" }>).chat.chatId &&
      a.chat.chatType === (b as Extract<Target, { mode: "chat" }>).chat.chatType));

const uniqueSorted = (keys: readonly string[]): string[] => [...new Set(keys)].sort();

/** cron / runAt as the service's trigger; undefined when neither is given. */
function triggerOf(i: { cron?: string | undefined; runAt?: string | undefined }) {
  if (i.cron !== undefined) return { kind: "cron", expr: i.cron.trim() } satisfies TriggerInput;
  if (i.runAt !== undefined) return { kind: "once", at: i.runAt.trim() } satisfies TriggerInput;
  return undefined;
}

/** `chat` against the mode on create, as a refusal; null when they agree. */
function createChatError(i: {
  mode: z.infer<typeof Mode>;
  chat?: ChatInput | undefined;
}): ToolError | null {
  if (i.mode !== "chat" && i.chat !== undefined) return new ToolError(CHAT_ONLY_TEXT);
  if (i.mode === "chat" && i.chat === undefined) return new ToolError(CHAT_NEEDS_CHAT_TEXT);
  return null;
}

/** `chat` against the mode on update; null when they agree (or chat is absent). */
function updateChatError(i: {
  mode?: z.infer<typeof Mode> | undefined;
  chat?: ChatInput | undefined;
}): ToolError | null {
  if (i.chat === undefined) return null;
  return i.mode !== "chat" ? new ToolError(CHAT_ONLY_TEXT) : null;
}

const withZone = (t: TriggerInput, timeZone: string): ScheduleTrigger =>
  t.kind === "cron"
    ? { kind: "cron", expr: t.expr, timeZone }
    : { kind: "once", at: t.at, timeZone };

/** A card as stored on the approval (the same clipping at ask time and at run time). */
const cardOf = (w: Words): Words => ({ zh: clip(w.zh, 1000), en: clip(w.en, 1000) });

/** The fixed ask of a create or update: every call asks, only "once", with the kernel's card. */
const ask = (key: string, summary: Words): CallPolicy => ({
  key,
  policy: "ask",
  remember: false,
  summary: cardOf(summary),
});

const deny = (key: string, denyReason: string): CallPolicy => ({
  key,
  policy: "deny",
  remember: false,
  denyReason,
});

/** The live role of the person in the org, or null when they are not a member. */
async function roleOf(db: KernelSchemaDb, orgId: string, accountId: string) {
  const m = await db
    .selectFrom("memberships")
    .select("role")
    .where("org_id", "=", orgId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return (m?.role ?? null) as OrgRole | null;
}

/**
 * `ScheduleUpdate`'s write in one transaction: the field change, then (with `approvedTools`) the
 * task's grants replaced by exactly that list. Each service call is `@Transactional` and joins
 * this one, so a refused grant rolls the field change back too.
 */
@Injectable()
export class ScheduleUpdates {
  constructor(
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ScheduledTaskStore) private readonly store: ScheduledTaskStore,
  ) {}

  @Transactional()
  async apply(
    svc: Pick<ScheduleService, "update" | "addGrants" | "removeGrant">,
    orgId: string,
    accountId: string,
    task: ScheduledTask,
    patch: UpdateTaskInput,
    approvedTools: readonly string[] | undefined,
  ): Promise<ScheduledTask> {
    const updated =
      Object.keys(patch).length > 0 ? await svc.update(orgId, accountId, task.id, patch) : task;
    if (approvedTools !== undefined) {
      const next = uniqueSorted(approvedTools);
      const held = (await this.store.listGrants(this.db.db, task.id)).map((g) => g.toolKey);
      for (const k of held.filter((k) => !next.includes(k))) {
        await svc.removeGrant(orgId, accountId, task.id, k);
      }
      const added = next.filter((k) => !held.includes(k));
      if (added.length > 0) {
        await svc.addGrants(
          orgId,
          accountId,
          task.id,
          added.map((toolKey) => ({ toolKey })),
        );
      }
    }
    return updated;
  }
}

/** The five schedule builtins. */
export function scheduleTools(deps: ScheduleToolsDeps): BuiltinTool[] {
  /**
   * The service, or a refusal (the tools are hidden then too: {@link unavailable}). Defensive:
   * `SchedulesModule` is reachable on every role (through ChannelsModule / KernelModule), so the
   * port is expected to be bound; the path stays for an application built without it.
   */
  const service = async (): Promise<ScheduleService> => {
    const s = deps.service();
    if (s === null) throw new ToolError(SCHEDULES_UNAVAILABLE_TEXT);
    return s;
  };

  /** Not loaded on this replica, or turned off in the org: one read per listing. */
  const unavailable = async (scope: ToolListingScope): Promise<string | null> => {
    if (deps.service() === null) return SCHEDULES_UNAVAILABLE_TEXT;
    const memoKey = "schedules:enabled";
    let enabled = scope.memo?.get(memoKey) as Promise<boolean> | undefined;
    if (enabled === undefined) {
      enabled = readScheduleSettings(deps.db(), deps.config, scope.orgId).then((s) => s.enabled);
      scope.memo?.set(memoKey, enabled);
    }
    return (await enabled) ? null : SCHEDULES_OFF_TEXT;
  };

  /**
   * The card the person approved for this call (`approvals.summary` of the call's latest
   * approved attempt); undefined when the call has no approval (a direct call outside the
   * pipeline: the pipeline never runs a fixed ask without one).
   */
  async function approvedCard(ctx: BuiltinCallContext): Promise<Words | null | undefined> {
    if (ctx.runId === undefined) return undefined;
    const row = await deps
      .db()
      .selectFrom("approvals")
      .select("summary")
      .where("run_id", "=", ctx.runId)
      .where("call_id", "=", ctx.callId)
      .where("status", "=", "approved")
      .orderBy("attempt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : row.summary;
  }

  /** Refuses the run when the card it would show now differs from the approved one. */
  async function sameAsApproved(ctx: BuiltinCallContext, tool: string, now: Words) {
    const shown = await approvedCard(ctx);
    if (shown === undefined) return;
    const c = cardOf(now);
    if (shown === null || shown.zh !== c.zh || shown.en !== c.en) {
      throw new ToolError(cardChangedText(tool));
    }
  }

  /** The person's live role, refused when they are no longer a member. */
  async function liveRole(ctx: BuiltinCallContext): Promise<OrgRole> {
    const role = await roleOf(deps.db(), ctx.orgId, ctx.accountId);
    if (role === null) throw new ToolError(NOT_A_MEMBER_TEXT);
    return role;
  }

  /** Runs a service call, turning its refusals into actionable tool errors. */
  async function call<T>(fn: () => Promise<T>, ctx: { id?: string; zone?: string }): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError) throw new ToolError(scheduleErrorText(e, ctx));
      throw e;
    }
  }

  // ---- ScheduleCreate ----

  type CreatePlan = Awaited<ReturnType<typeof createPlan>>;

  async function createPlan(input: CreateInput, ctx: CallPolicyContext | BuiltinCallContext) {
    const trigger = triggerOf(input);
    const zone = await deps.timeZoneOf(ctx.orgId, ctx.conversationId);
    const target: Target =
      input.mode === "here"
        ? await hereTarget(deps.db(), ctx.orgId, ctx.accountId, ctx.conversationId)
        : input.mode === "chat"
          ? await chatTargetOf(deps.db(), normalizedChat(input.chat as ChatInput))
          : { mode: "new" };
    return {
      trigger,
      zone,
      target,
      tools: uniqueSorted(input.approvedTools ?? []),
      agentId: input.chat?.agentId ?? ctx.agentId,
    };
  }

  function createCard(
    input: CreateInput,
    p: CreatePlan,
    conversationId: string,
    runAgentId: string,
  ): Words {
    const when = scheduleWords(withZone(p.trigger as TriggerInput, p.zone));
    const where = targetWords(p.target, conversationId);
    const tools = toolsWords(p.tools);
    const name = clip(input.name, NAME_MAX);
    const agent =
      p.agentId === runAgentId
        ? { zh: "", en: "" }
        : { zh: `；以智能体 ${p.agentId} 运行`, en: `; runs as agent ${p.agentId}` };
    return {
      zh: `创建定时任务「${name}」：${when.zh}；运行位置：${where.zh}${agent.zh}；预先批准的工具：${tools.zh}`,
      en: `Create the scheduled task "${name}": ${when.en}; runs in ${where.en}${agent.en}; approved tools: ${tools.en}`,
    };
  }

  const create: BuiltinTool = {
    spec: CREATE_SPEC,
    defaultPolicy: "ask",
    unavailable,
    async callPolicy(raw, ctx) {
      const key = BUILTIN.ScheduleCreate;
      const parsed = CreateInput.safeParse(raw);
      if (!parsed.success) return deny(key, INVALID_CREATE_TEXT);
      if ((parsed.data.cron === undefined) === (parsed.data.runAt === undefined)) {
        return deny(key, ONE_TRIGGER_TEXT);
      }
      const bad = createChatError(parsed.data);
      if (bad !== null) return deny(key, bad.message);
      const p = await createPlan(parsed.data, ctx);
      return ask(key, createCard(parsed.data, p, ctx.conversationId, ctx.agentId));
    },
    async run(raw, ctx) {
      const parsed = CreateInput.safeParse(raw);
      if (!parsed.success) throw new ToolError(INVALID_CREATE_TEXT);
      const input = parsed.data;
      const bad = createChatError(input);
      if (bad !== null) throw bad;
      const svc = await service();
      const p = await createPlan(input, ctx);
      if (p.trigger === undefined || (input.cron !== undefined && input.runAt !== undefined)) {
        throw new ToolError(ONE_TRIGGER_TEXT);
      }
      // the zone and target are recomputed now: they must be the ones the person approved
      await sameAsApproved(
        ctx,
        BUILTIN.ScheduleCreate,
        createCard(input, p, ctx.conversationId, ctx.agentId),
      );
      const trigger = p.trigger;
      const task = await call(
        () =>
          svc.create(ctx.orgId, ctx.accountId, {
            agentId: p.agentId,
            name: input.name,
            prompt: input.prompt,
            trigger,
            timeZone: p.zone,
            ...targetFields(p.target),
            grants: p.tools.map((toolKey) => ({ toolKey })),
          }),
        { zone: p.zone },
      );
      const when = scheduleWords(task.trigger);
      const where = targetWords(p.target, ctx.conversationId);
      const next = nextRunWords(task.trigger, deps.now());
      return {
        content: [
          {
            type: "text",
            text:
              `Created scheduled task "${task.name}" (id ${task.id}): runs ${when.en} in ` +
              `${where.en}${next === null ? "" : `; next run ${next}`}. Approved tools: ` +
              `${toolsWords(p.tools).en}.`,
          },
        ],
        display: display(
          `已创建定时任务「${task.name}」 · ${when.zh}`,
          `Created scheduled task "${task.name}" · ${when.en}`,
        ),
      };
    },
  };

  // ---- ScheduleUpdate ----

  /** The task's approved tool keys, sorted. */
  const grantKeys = async (taskId: string): Promise<string[]> =>
    uniqueSorted((await deps.store.listGrants(deps.db(), taskId)).map((g) => g.toolKey));

  /** The person's own live task, or null. */
  async function ownTask(orgId: string, accountId: string, id: string) {
    const task = await deps.store.getTask(deps.db(), orgId, id);
    return task !== null && task.accountId === accountId ? task : null;
  }

  async function updateCard(
    input: UpdateInput,
    task: ScheduledTask,
    grants: readonly string[],
    ctx: Pick<CallPolicyContext, "orgId" | "accountId" | "conversationId">,
  ): Promise<Words> {
    const zh: string[] = [];
    const en: string[] = [];
    if (input.name !== undefined && input.name.trim() !== task.name) {
      zh.push(`名称「${clip(task.name, 80)}」→「${clip(input.name, 80)}」`);
      en.push(`name "${clip(task.name, 80)}" → "${clip(input.name, 80)}"`);
    }
    if (input.prompt !== undefined && input.prompt.trim() !== task.prompt) {
      const shown = clip(input.prompt, PROMPT_SHOWN);
      zh.push(`新提示词「${shown}」`);
      en.push(`new prompt "${shown}"`);
    }
    const trigger = triggerOf(input);
    if (trigger !== undefined) {
      const before = scheduleWords(task.trigger);
      const after = scheduleWords(withZone(trigger, task.trigger.timeZone));
      zh.push(`时间 ${before.zh} → ${after.zh}`);
      en.push(`schedule ${before.en} → ${after.en}`);
    }
    if (input.mode !== undefined) {
      const db = deps.db();
      const before = await storedTarget(db, task);
      const after: Target =
        input.mode === "here"
          ? await hereTarget(db, ctx.orgId, ctx.accountId, ctx.conversationId)
          : input.mode === "chat"
            ? await chatTargetOf(db, normalizedChat(input.chat as ChatInput))
            : { mode: "new" };
      if (!sameTarget(before, after)) {
        const b = targetWords(before, ctx.conversationId);
        const a = targetWords(after, ctx.conversationId);
        zh.push(`运行位置 ${b.zh} → ${a.zh}`);
        en.push(`runs in ${b.en} → ${a.en}`);
      }
    }
    if (input.chat?.agentId !== undefined && input.chat.agentId !== task.agentId) {
      zh.push(`智能体 ${clip(task.agentId, 80)} → ${clip(input.chat.agentId, 80)}`);
      en.push(`agent ${clip(task.agentId, 80)} → ${clip(input.chat.agentId, 80)}`);
    }
    if (input.approvedTools !== undefined) {
      const next = uniqueSorted(input.approvedTools);
      const added = next.filter((k) => !grants.includes(k));
      const removed = grants.filter((k) => !next.includes(k));
      const all = toolsWords(next);
      const delta = [
        ...(added.length > 0
          ? [{ zh: `新增 ${added.join("、")}`, en: `adds ${added.join(", ")}` }]
          : []),
        ...(removed.length > 0
          ? [{ zh: `移除 ${removed.join("、")}`, en: `removes ${removed.join(", ")}` }]
          : []),
      ];
      const dZh = delta.length > 0 ? `（${delta.map((d) => d.zh).join("；")}）` : "（不变）";
      const dEn = delta.length > 0 ? ` (${delta.map((d) => d.en).join("; ")})` : " (unchanged)";
      zh.push(`预先批准的工具：${all.zh}${dZh}`);
      en.push(`approved tools: ${all.en}${dEn}`);
    } else {
      // the tools the task keeps are part of what the person approves
      const kept = toolsWords(grants);
      zh.push(`预先批准的工具：${kept.zh}（不变）`);
      en.push(`approved tools: ${kept.en} (unchanged)`);
    }
    const name = clip(task.name, 80);
    const none = { zh: "没有改动", en: "no changes" };
    return {
      zh: `修改定时任务「${name}」：${zh.length > 0 ? zh.join("；") : none.zh}`,
      en: `Change the scheduled task "${name}": ${en.length > 0 ? en.join("; ") : none.en}`,
    };
  }

  const nothingToUpdate = (i: UpdateInput) =>
    i.name === undefined &&
    i.prompt === undefined &&
    i.cron === undefined &&
    i.runAt === undefined &&
    i.mode === undefined &&
    i.chat === undefined &&
    i.approvedTools === undefined;

  const update: BuiltinTool = {
    spec: UPDATE_SPEC,
    defaultPolicy: "ask",
    unavailable,
    async callPolicy(raw, ctx) {
      const key = BUILTIN.ScheduleUpdate;
      const parsed = UpdateInput.safeParse(raw);
      if (!parsed.success) return deny(key, INVALID_UPDATE_TEXT);
      const input = parsed.data;
      if (input.cron !== undefined && input.runAt !== undefined) {
        return deny(key, BOTH_TRIGGERS_TEXT);
      }
      const bad = updateChatError(input);
      if (bad !== null) return deny(key, bad.message);
      if (nothingToUpdate(input)) return deny(key, NOTHING_TO_UPDATE_TEXT);
      const task = await ownTask(ctx.orgId, ctx.accountId, input.id);
      if (task === null) return deny(key, notYoursText(input.id));
      const grants = await grantKeys(task.id);
      return ask(key, await updateCard(input, task, grants, ctx));
    },
    async run(raw, ctx) {
      const parsed = UpdateInput.safeParse(raw);
      if (!parsed.success) throw new ToolError(INVALID_UPDATE_TEXT);
      const input = parsed.data;
      if (input.cron !== undefined && input.runAt !== undefined) {
        throw new ToolError(BOTH_TRIGGERS_TEXT);
      }
      const bad = updateChatError(input);
      if (bad !== null) throw bad;
      if (nothingToUpdate(input)) throw new ToolError(NOTHING_TO_UPDATE_TEXT);
      const svc = await service();
      const task = await ownTask(ctx.orgId, ctx.accountId, input.id);
      if (task === null) throw new ToolError(notYoursText(input.id));
      await sameAsApproved(
        ctx,
        BUILTIN.ScheduleUpdate,
        await updateCard(input, task, await grantKeys(task.id), ctx),
      );
      const patch: UpdateTaskInput = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.prompt !== undefined) patch.prompt = input.prompt;
      const trigger = triggerOf(input);
      if (trigger !== undefined) patch.trigger = trigger;
      if (input.mode !== undefined) {
        const target: Target =
          input.mode === "here"
            ? await hereTarget(deps.db(), ctx.orgId, ctx.accountId, ctx.conversationId)
            : input.mode === "chat"
              ? await chatTargetOf(deps.db(), normalizedChat(input.chat as ChatInput))
              : { mode: "new" };
        const f = targetFields(target);
        patch.mode = f.mode;
        patch.conversationId = f.conversationId ?? null;
        patch.chat = f.chat ?? null;
        // the chat's agent maps to the service's task agent (the HTTP shape stays flat)
        if (input.chat?.agentId !== undefined) patch.agentId = input.chat.agentId;
      }
      const zone = task.trigger.timeZone;
      const updated = await call(
        () => deps.updates.apply(svc, ctx.orgId, ctx.accountId, task, patch, input.approvedTools),
        { id: input.id, zone },
      );
      const grants = await grantKeys(updated.id);
      const when = scheduleWords(updated.trigger);
      const where = targetWords(await storedTarget(deps.db(), updated), ctx.conversationId);
      const next = updated.status === "active" ? nextRunWords(updated.trigger, deps.now()) : null;
      return {
        content: [
          {
            type: "text",
            text:
              `Updated scheduled task "${updated.name}" (id ${updated.id}): runs ${when.en} in ` +
              `${where.en}; status ${updated.status}${next === null ? "" : `; next run ${next}`}. ` +
              `Approved tools: ${toolsWords(grants).en}.`,
          },
        ],
        display: display(
          `已修改定时任务「${updated.name}」`,
          `Updated scheduled task "${updated.name}"`,
        ),
      };
    },
  };

  // ---- ScheduleList ----

  const list: BuiltinTool = {
    spec: LIST_SPEC,
    defaultPolicy: "allow",
    unavailable,
    async run(_raw, ctx) {
      const svc = await service();
      await liveRole(ctx);
      const tasks = await call(() => svc.list(ctx.orgId, { accountId: ctx.accountId }), {});
      if (tasks.length === 0) {
        return {
          content: [
            { type: "text", text: "The user has no scheduled tasks in this organization." },
          ],
          display: display("没有定时任务", "No scheduled tasks"),
        };
      }
      const db = deps.db();
      const lines: string[] = [];
      for (const t of tasks) {
        const where = targetWords(await storedTarget(db, t), ctx.conversationId).en;
        const status =
          t.status === "paused" && t.pauseReason !== null ? `paused (${t.pauseReason})` : t.status;
        const next =
          t.nextRunAt === null
            ? "none"
            : localTime(t.nextRunAt, t.trigger.timeZone).local.slice(0, 16).replace("T", " ");
        lines.push(
          `- ${t.id}: "${t.name}", ${scheduleWords(t.trigger).en}, ${status}, next run ${next}, ` +
            `runs in ${where}`,
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `The user's scheduled tasks (${tasks.length}):\n${lines.join("\n")}`,
          },
        ],
        display: display(
          `列出定时任务（${tasks.length} 个）`,
          `Listed ${tasks.length} scheduled tasks`,
        ),
      };
    },
  };

  // ---- ScheduleTargets ----

  /** A target's fields in the model-facing line (`ScheduleTargets`). */
  const targetLine = (t: ChatTarget): string =>
    `- ${clip(t.label, 120)}: connectionId=${t.connectionId}, chatId=${t.chatId}, ` +
    `chatType=${t.chatType}, agentId=${t.agentId} (${clip(t.connectionName, 80)}, ${t.plugin})`;

  const targets: BuiltinTool = {
    spec: TARGETS_SPEC,
    defaultPolicy: "allow",
    unavailable,
    async run(_raw, ctx) {
      const svc = await service();
      await liveRole(ctx);
      const items = await call(() => svc.chatTargets(ctx.orgId, ctx.accountId), {});
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "The user has no IM chats scheduled task runs can be delivered to in this " +
                "organization; a chat appears once the user has messaged the channel's bot or " +
                "talked in a group.",
            },
          ],
          display: display("没有可送达的聊天", "No delivery chats"),
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `The IM chats this user can deliver scheduled task runs to (${items.length}):\n` +
              items.map(targetLine).join("\n"),
          },
        ],
        display: display(
          `可送达的聊天（${items.length} 个）`,
          `Listed ${items.length} delivery chats`,
        ),
      };
    },
  };

  // ---- ScheduleDelete ----

  const remove: BuiltinTool = {
    spec: DELETE_SPEC,
    // deleting one's own task only narrows what runs (spec §11)
    defaultPolicy: "allow",
    unavailable,
    async run(raw, ctx) {
      const parsed = IdInput.safeParse(raw);
      if (!parsed.success) throw new ToolError(INVALID_ID_TEXT);
      const { id } = parsed.data;
      const svc = await service();
      // only the person's own task, even for an org admin (who may delete others' on the page)
      const task = await ownTask(ctx.orgId, ctx.accountId, id);
      if (task === null) throw new ToolError(notYoursText(id));
      await liveRole(ctx);
      await call(() => svc.remove(ctx.orgId, { accountId: ctx.accountId }, task.id), { id });
      return {
        content: [{ type: "text", text: `Deleted scheduled task "${task.name}" (id ${task.id}).` }],
        display: display(`已删除定时任务「${task.name}」`, `Deleted scheduled task "${task.name}"`),
      };
    },
  };

  return [create, update, list, targets, remove];
}
