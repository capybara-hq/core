import { randomUUID } from "node:crypto";
import { CHANNEL_EXTENSION_POINT, type Channel } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { AgentLookup, type AgentView } from "../agents/agent-lookup.js";
import type { ModelRef } from "../agents/definition.js";
import { ConversationAccess } from "../conversations/access.js";
import { readMessageContext } from "../conversations/message-context.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { isTimeZone } from "../time-zone.js";
import { BUILTIN } from "../tools/builtin-names.js";
import { isFixedAsk } from "../tools/policy.js";
import { type ResolvedTool, ToolRegistry } from "../tools/registry.js";
import { type EffectiveScheduleSettings, readScheduleSettings } from "./effective-settings.js";
import {
  grantNotAllowed,
  scheduleDisabled,
  scheduleForbidden,
  scheduleNotFound,
  targetInvalid,
} from "./errors.js";
import { schedFireJob } from "./job-ids.js";
import { pauseTaskIn } from "./pause.js";
import { jitterForGap, minGapMinutes, nextTick, validateTrigger } from "./schedule-math.js";
import { type ScheduledTaskPatch, ScheduledTaskStore } from "./store.js";
import type {
  ScheduleChat,
  ScheduledTask,
  ScheduledTaskGrant,
  ScheduleMode,
  SchedulePauseReason,
  ScheduleTrigger,
  TaskRun,
} from "./types.js";

/** When a task fires, before the zone is fixed (spec §5). */
export type TriggerInput = { kind: "cron"; expr: string } | { kind: "once"; at: string };

/** A scheduled task that needs its creator's attention (spec §8): the inbox item's payload. */
export interface ScheduleAttention {
  taskId: string;
  name: string;
  /**
   * `missing_grants`: the latest run was refused tools or connections the task lacks; `failed`:
   * the latest settled run of an active task failed (its start included); else the pause reason.
   */
  reason: SchedulePauseReason | "missing_grants" | "failed";
  /** The person who paused the task (`reason: "admin"` names the admin); else null. */
  pausedBy: { id: string; name: string } | null;
  /**
   * `missing_grants` only: tool keys the latest run was refused and the task has no grant for now,
   * or `connection:<slug>` (connect that connector).
   */
  missing: string[];
  /** The subset of `missing` the creator cannot pre-approve (the tool needs a higher role). */
  needsRole: string[];
  /** `failed` only: the run's error; else null. */
  error: string | null;
  /** When the pause happened, or when the refused or failed run was due. */
  at: Date;
}

/** A tool the creator pre-approves for the task; the service resolves its current `spec_hash`. */
export interface GrantInput {
  toolKey: string;
  /** The connector the tool comes from; when given it must be the tool's own. */
  connectorId?: string;
}

export interface CreateTaskInput {
  agentId: string;
  name: string;
  prompt: string;
  trigger: TriggerInput;
  /** Absent: the creator's effective zone (account, browser, org, UTC). */
  timeZone?: string;
  mode: ScheduleMode;
  /** `conversation` mode only. */
  conversationId?: string;
  /** `chat` mode only. */
  chat?: ScheduleChat;
  /**
   * `new` mode only (a conversation or chat task runs with that conversation's selection and
   * device): the model, which must resolve for the org, and an effort it declares.
   */
  model?: ModelRef;
  effort?: string;
  deviceId?: string;
  /**
   * When the task ends; it must lie in the future. Absent or null: for a cron task, now + the
   * org's `defaultExpiryDays` when set; otherwise never.
   */
  expiresAt?: Date | null;
  grants?: GrantInput[];
}

/**
 * Fields to change; `null` clears an optional one (`expiresAt: null` is the org's default expiry
 * for a cron task, as on create). Grants change through their own methods.
 */
export interface UpdateTaskInput {
  agentId?: string;
  name?: string;
  prompt?: string;
  trigger?: TriggerInput;
  timeZone?: string;
  mode?: ScheduleMode;
  conversationId?: string | null;
  chat?: ScheduleChat | null;
  model?: ModelRef | null;
  effort?: string | null;
  deviceId?: string | null;
  expiresAt?: Date | null;
}

/** Who acts on a task: the service reads their live role itself and decides by that one. */
export interface ScheduleActor {
  accountId: string;
}

const RUNS_DEFAULT = 50;
const RUNS_MAX = 200;
const DAY_MS = 86_400_000;
/** Longest task name and prompt, in characters. */
const NAME_MAX = 200;
const PROMPT_MAX = 20_000;

/** A DM thread's key on `channel_threads` (`channels/threads.ts` `threadKeyOf`). */
const DM_THREAD_PREFIX = "dm:";

/**
 * Why `tool` cannot be one of a task's grants (spec §7), or null when it can: the creator could
 * approve it with scope `always` themselves (no `requiredRole` above their role, not a fixed ask),
 * it is not `SkillWrite` (an unattended run never rewrites the agent's skills) and the org did not
 * forbid it. `tool` undefined: the agent does not have that tool now.
 */
export function grantRefusal(
  toolKey: string,
  tool: ResolvedTool | undefined,
  ctx: GrantContext,
): string | null {
  return grantRefusalOf(toolKey, tool, ctx)?.message ?? null;
}

/** Who asks for a grant and where: the inputs of {@link grantRefusal}. */
export interface GrantContext {
  role: OrgRole;
  visibility: AgentView["visibility"];
  skillWritePolicy?: "allow" | "ask" | undefined;
  forbiddenTools: readonly string[];
}

/**
 * Why a tool can't be a task's grant, as a code the UI words: `forbidden` (the org's
 * `forbiddenTools`), `not_grantable` (by design: `SkillWrite`), `not_available` (not one of the
 * agent's tools now), `needs_role` (a `requiredRole` above the creator's), `fixed_ask` (always
 * asks a person).
 */
export type GrantRefusalCode =
  | "forbidden"
  | "not_grantable"
  | "not_available"
  | "needs_role"
  | "fixed_ask";

/** {@link grantRefusal} with its code; null when the tool can be granted. */
export function grantRefusalOf(
  toolKey: string,
  tool: ResolvedTool | undefined,
  ctx: GrantContext,
): { code: GrantRefusalCode; message: string } | null {
  if (ctx.forbiddenTools.includes(toolKey)) {
    return {
      code: "forbidden",
      message: `The organization does not allow ${toolKey} in scheduled runs`,
    };
  }
  if (toolKey === BUILTIN.SkillWrite) {
    return {
      code: "not_grantable",
      message: `${toolKey} cannot be approved for a scheduled task: an unattended run never changes the agent's skills`,
    };
  }
  if (!tool) {
    return { code: "not_available", message: `${toolKey} is not one of the agent's tools now` };
  }
  if (tool.requiredRole !== undefined && !roleAtLeast(ctx.role, tool.requiredRole)) {
    return {
      code: "needs_role",
      message: `${toolKey} needs the ${tool.requiredRole} role to approve; you cannot approve it for the task`,
    };
  }
  if (isFixedAsk(tool, ctx.visibility, ctx.skillWritePolicy)) {
    return {
      code: "fixed_ask",
      message: `${toolKey} always asks a person and cannot be approved in advance`,
    };
  }
  return null;
}

/** One of the agent's tools as the task form offers it (`GET …/schedules/grantable-tools`). */
export interface GrantableTool {
  key: string;
  /** The tool's display title, when it declares one. */
  title: string | null;
  source: "builtin" | "plugin" | "connector";
  connectorId: string | null;
  grantable: boolean;
  /** Why not, when not grantable. */
  reason: GrantRefusalCode | null;
}

/** A grant as the task page shows it: `stale` when the tool's definition changed (spec §7). */
export interface ScheduledTaskGrantView extends ScheduledTaskGrant {
  stale: boolean;
}

/** The latest settled (completed, failed or skipped) non-trial run of a task. */
export interface TaskLastRun {
  status: "completed" | "failed" | "skipped";
  skipReason: TaskRun["skipReason"];
  /** When it fired; its tick for a skipped one. */
  at: Date;
}

/** A task in a list, with its latest settled run. */
export type ScheduledTaskListItem = ScheduledTask & { lastRun: TaskLastRun | null };

/**
 * A chat the creator can point a `chat` task at (spec §8): their DM with a connection's bot
 * (a thread row of theirs, archived included), or a group they have talked in when the channel
 * has threads.
 */
export interface ChatTarget {
  connectionId: string;
  connectionName: string;
  plugin: string;
  /** The connection's agent: a chat task's agent. */
  agentId: string;
  chatId: string;
  chatType: "dm" | "group";
  /** A name for people: the connection's name (and the group's chat id). */
  label: string;
}

/**
 * Scheduled tasks for people (spec §5, §7–§10): create, edit, pause, resume, delete, their runs
 * and grants. Every write runs in one transaction under the org row lock (`OrgLock`), which also
 * serializes the per-member and per-org caps, re-reads the actor's role there, and holds the task
 * row (`FOR UPDATE`) so the scanner skips it until the write commits.
 *
 * Roles: `schedules.use` (member) creates and edits one's own tasks; `schedules.manage` (admin)
 * lists, pauses, resumes and deletes any task of the org, never edits another person's (the task
 * runs as its creator). A task the caller may not see is `schedule.not_found`.
 */
@Injectable()
export class ScheduledTasksService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ScheduledTaskStore) private readonly store: ScheduledTaskStore,
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "get">,
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    @Inject(ToolRegistry) private readonly tools: Pick<ToolRegistry, "forAgent">,
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "list">,
    /** A task's model must resolve for the org and declare its effort (as a message's switch). */
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    /** "Run now" enqueues the fire job (consumed by the worker role). */
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly maintenance: Pick<Queue, "add">,
  ) {}

  @Transactional()
  async create(
    orgId: string,
    accountId: string,
    input: CreateTaskInput,
    browserTimeZone?: string,
  ): Promise<ScheduledTask> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "schedules.use");
    const t = this.db.db;
    const settings = await readScheduleSettings(t, this.config, orgId);
    if (!settings.enabled) throw scheduleDisabled();
    if ((await this.store.countActive(t, orgId, accountId)) >= settings.maxTasksPerMember) {
      throw new ApiError(
        "schedule.limit_reached",
        `You already have ${settings.maxTasksPerMember} scheduled tasks in this organization; delete one to create another`,
      );
    }
    if ((await this.store.countActive(t, orgId)) >= settings.maxTasksPerOrg) {
      throw new ApiError(
        "schedule.limit_reached",
        `This organization already has ${settings.maxTasksPerOrg} scheduled tasks; delete one to create another`,
      );
    }
    const name = requiredText(input.name, "name", NAME_MAX);
    const prompt = requiredText(input.prompt, "prompt", PROMPT_MAX);
    const agent = await this.agents.get(orgId, input.agentId, accountId);
    const timeZone =
      input.timeZone ??
      (
        await readMessageContext(t, {
          orgId,
          accountId,
          ...(browserTimeZone !== undefined && { browser: { timeZone: browserTimeZone } }),
        })
      ).timeZone ??
      "UTC";
    const now = new Date();
    const trigger = withZone(input.trigger, timeZone);
    const gap = checkTrigger(trigger, now, settings);
    const target = {
      mode: input.mode,
      conversationId: input.conversationId ?? null,
      chat: input.chat ?? null,
    };
    await this.checkTarget(orgId, accountId, agent.id, target);
    const pick = {
      model: input.model ?? null,
      effort: input.effort ?? null,
      deviceId: input.deviceId ?? null,
    };
    await this.checkPick(orgId, accountId, agent, target.mode, pick);
    const expiresAt = expiryOf(input.expiresAt ?? null, trigger, now, settings);
    const grants = await this.resolveGrants(orgId, role, agent, settings, input.grants ?? []);
    const id = randomUUID();
    const jitter = jitterForGap(id, gap);
    const task = await this.store.insertTask(t, {
      id,
      orgId,
      accountId,
      agentId: agent.id,
      name,
      prompt,
      trigger,
      ...target,
      ...pick,
      status: "active",
      nextRunAt: fireAt(trigger, now, jitter),
      jitterSeconds: jitter,
      expiresAt,
    });
    for (const g of grants) await this.store.addGrant(t, id, g);
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "schedule.created",
      target: id,
      detail: {
        name,
        agentId: agent.id,
        mode: target.mode,
        trigger,
        grants: grants.map((g) => g.toolKey),
      },
    });
    return task;
  }

  /** Creator only: an org admin gets `schedule.forbidden`, anyone else `schedule.not_found`. */
  @Transactional()
  async update(
    orgId: string,
    accountId: string,
    id: string,
    patch: UpdateTaskInput,
  ): Promise<ScheduledTask> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "schedules.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    const settings = await readScheduleSettings(t, this.config, orgId);
    const now = new Date();
    const changes: ScheduledTaskPatch = {};
    if (patch.name !== undefined) changes.name = requiredText(patch.name, "name", NAME_MAX);
    if (patch.prompt !== undefined) {
      changes.prompt = requiredText(patch.prompt, "prompt", PROMPT_MAX);
    }

    const agentId = patch.agentId ?? task.agentId;
    let newAgent: AgentView | undefined;
    if (patch.agentId !== undefined && patch.agentId !== task.agentId) {
      const agent = await this.agents.get(orgId, patch.agentId, accountId);
      newAgent = agent;
      changes.agentId = agent.id;
      // the grants were approved for the old agent's tools: each must hold for the new agent
      // too (refused, so the creator sees which), and takes the new agent's definition
      const held = await this.store.listGrants(t, task.id);
      const regranted = await this.resolveGrants(
        orgId,
        role,
        agent,
        settings,
        held.map((g) => ({
          toolKey: g.toolKey,
          ...(g.connectorId !== null && { connectorId: g.connectorId }),
        })),
      );
      for (const g of regranted) await this.store.addGrant(t, task.id, g);
    }
    const target = {
      mode: patch.mode ?? task.mode,
      conversationId:
        patch.conversationId !== undefined ? patch.conversationId : task.conversationId,
      chat: patch.chat !== undefined ? patch.chat : task.chat,
    };
    const targetChanged =
      changes.agentId !== undefined ||
      patch.mode !== undefined ||
      patch.conversationId !== undefined ||
      patch.chat !== undefined;
    if (targetChanged) {
      await this.checkTarget(orgId, accountId, agentId, target);
      Object.assign(changes, target);
    }

    if (patch.trigger !== undefined || patch.timeZone !== undefined) {
      const zone = patch.timeZone ?? task.trigger.timeZone;
      const base: TriggerInput =
        patch.trigger ??
        (task.trigger.kind === "cron"
          ? { kind: "cron", expr: task.trigger.expr }
          : { kind: "once", at: task.trigger.at });
      const trigger = withZone(base, zone);
      const gap = checkTrigger(trigger, now, settings);
      changes.trigger = trigger;
      changes.jitterSeconds = jitterForGap(task.id, gap);
      if (task.status === "active") {
        changes.nextRunAt = fireAt(trigger, now, changes.jitterSeconds);
      }
    }
    // model, effort and device: `new` mode only (leaving it clears them), checked when they or
    // the agent change
    const pick =
      target.mode === "new"
        ? {
            model: patch.model !== undefined ? patch.model : task.model,
            effort: patch.effort !== undefined ? patch.effort : task.effort,
            deviceId: patch.deviceId !== undefined ? patch.deviceId : task.deviceId,
          }
        : {
            model: patch.model ?? null,
            effort: patch.effort ?? null,
            deviceId: patch.deviceId ?? null,
          };
    const pickChanged =
      patch.model !== undefined ||
      patch.effort !== undefined ||
      patch.deviceId !== undefined ||
      targetChanged;
    if (pickChanged) {
      await this.checkPick(
        orgId,
        accountId,
        newAgent ?? (await this.agents.get(orgId, agentId, accountId)),
        target.mode,
        pick,
        patch.deviceId !== undefined,
      );
      if (pick.model !== task.model) changes.model = pick.model;
      if (pick.effort !== task.effort) changes.effort = pick.effort;
      if (pick.deviceId !== task.deviceId) changes.deviceId = pick.deviceId;
    }
    if (patch.expiresAt !== undefined) {
      changes.expiresAt = expiryOf(patch.expiresAt, changes.trigger ?? task.trigger, now, settings);
    }

    const updated = (await this.store.updateTask(t, task.id, changes)) ?? task;
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "schedule.updated",
      target: task.id,
      detail: { fields: Object.keys(changes).sort() },
    });
    return updated;
  }

  /** The creator, or an org admin (`schedules.manage`); a task not active is returned as is. */
  @Transactional()
  async pause(orgId: string, actor: ScheduleActor, id: string): Promise<ScheduledTask> {
    const { task, byAdmin } = await this.lockManaged(orgId, actor.accountId, id, "org.read");
    if (task.status !== "active") return task;
    const paused = await this.store.updateTask(this.db.db, task.id, {
      status: "paused",
      pauseReason: byAdmin ? "admin" : "creator",
      pausedBy: actor.accountId,
      nextRunAt: null,
    });
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      orgId,
      action: "schedule.paused",
      target: task.id,
      detail: { reason: byAdmin ? "admin" : "creator", creator: task.accountId },
    });
    return paused ?? task;
  }

  /**
   * The creator (`schedules.use`), or an org admin. The next run is computed from now (missed ticks
   * are not caught up) and the failure count starts over. An ended task cannot be resumed.
   */
  @Transactional()
  async resume(orgId: string, actor: ScheduleActor, id: string): Promise<ScheduledTask> {
    const { task, byAdmin } = await this.lockManaged(orgId, actor.accountId, id, "schedules.use");
    if (task.status === "active") return task;
    if (task.status === "ended") throw new ApiError("conflict", "This scheduled task has ended");
    const settings = await readScheduleSettings(this.db.db, this.config, orgId);
    if (!settings.enabled) throw scheduleDisabled();
    const now = new Date();
    const next = fireAt(task.trigger, now, task.jitterSeconds);
    if (next === null) {
      throw new ApiError("schedule.once_in_past", "The task's time has passed; set a new time");
    }
    const resumed = await this.store.updateTask(this.db.db, task.id, {
      status: "active",
      pauseReason: null,
      pausedBy: null,
      consecutiveFailures: 0,
      nextRunAt: next,
    });
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      orgId,
      action: "schedule.resumed",
      target: task.id,
      detail: { byAdmin, creator: task.accountId },
    });
    return resumed ?? task;
  }

  /** The creator, or an org admin. */
  @Transactional()
  async remove(orgId: string, actor: ScheduleActor, id: string): Promise<void> {
    const { task, byAdmin } = await this.lockManaged(orgId, actor.accountId, id, "org.read");
    await this.store.softDelete(this.db.db, task.id);
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      orgId,
      action: "schedule.deleted",
      target: task.id,
      detail: { byAdmin, creator: task.accountId, name: task.name },
    });
  }

  /** The creator, or an org admin. */
  async get(orgId: string, actor: ScheduleActor, id: string): Promise<ScheduledTask> {
    const role = await this.liveRole(orgId, actor.accountId);
    const task = await this.store.getTask(this.db.db, orgId, id);
    if (!task || (task.accountId !== actor.accountId && !can(role, "schedules.manage"))) {
      throw scheduleNotFound();
    }
    return task;
  }

  /** The actor's own tasks; `all` (org admins only, else `forbidden`): every task of the org. */
  async list(
    orgId: string,
    actor: ScheduleActor,
    opts: { all?: boolean; conversationId?: string } = {},
  ): Promise<ScheduledTaskListItem[]> {
    const role = await this.liveRole(orgId, actor.accountId);
    let tasks: ScheduledTask[];
    if (opts.all === true) {
      if (!can(role, "schedules.manage")) {
        throw new ApiError("forbidden", "Only org admins can list every scheduled task");
      }
      tasks = await this.store.listForOrg(this.db.db, orgId);
    } else {
      tasks = await this.store.listForAccount(this.db.db, orgId, actor.accountId);
    }
    if (opts.conversationId !== undefined) {
      tasks = await this.postingInto(orgId, tasks, opts.conversationId);
    }
    return this.withLastRuns(tasks);
  }

  /**
   * The tasks of `tasks` that post into the conversation: a `conversation` task naming it, or a
   * `chat` task whose chat the conversation is a thread of (spec §10 side panel).
   */
  private async postingInto(
    orgId: string,
    tasks: ScheduledTask[],
    conversationId: string,
  ): Promise<ScheduledTask[]> {
    const chats = tasks.some((t) => t.mode === "chat")
      ? await this.db.db
          .selectFrom("channel_threads")
          .innerJoin(
            "channel_connections",
            "channel_connections.id",
            "channel_threads.connection_id",
          )
          .select(["channel_threads.connection_id", "channel_threads.chat_id"])
          .where("channel_threads.conversation_id", "=", conversationId)
          .where("channel_connections.org_id", "=", orgId)
          .execute()
      : [];
    return tasks.filter((t) =>
      t.mode === "conversation"
        ? t.conversationId === conversationId
        : t.mode === "chat" &&
          t.chat !== null &&
          chats.some(
            (c) => c.connection_id === t.chat?.connectionId && c.chat_id === t.chat.chatId,
          ),
    );
  }

  /** Each task with its latest settled non-trial run, in one query. */
  private async withLastRuns(tasks: ScheduledTask[]): Promise<ScheduledTaskListItem[]> {
    if (tasks.length === 0) return [];
    const rows = await this.db.db
      .selectFrom("scheduled_task_runs")
      .select(["task_id", "status", "skip_reason", "fired_at", "scheduled_for"])
      .distinctOn("task_id")
      .where(
        "task_id",
        "in",
        tasks.map((t) => t.id),
      )
      .where("trial", "=", false)
      .where("status", "in", ["completed", "failed", "skipped"])
      .orderBy("task_id")
      .orderBy("scheduled_for", "desc")
      .orderBy("id", "desc")
      .execute();
    const last = new Map(rows.map((r) => [r.task_id, r]));
    return tasks.map((t) => {
      const r = last.get(t.id);
      return {
        ...t,
        lastRun:
          r === undefined
            ? null
            : {
                status: r.status as TaskLastRun["status"],
                skipReason: r.skip_reason,
                at: new Date(r.fired_at ?? r.scheduled_for),
              },
      };
    });
  }

  /**
   * The chats the caller can point a `chat` task at (spec §8): per active connection of the org,
   * their DM threads (archived included) and, on a channel with threads, the groups they have a
   * thread in. Members up (`schedules.use`, the route's).
   */
  async chatTargets(orgId: string, accountId: string): Promise<ChatTarget[]> {
    await this.liveRole(orgId, accountId);
    const rows = await this.db.db
      .selectFrom("channel_threads")
      .innerJoin("channel_connections", "channel_connections.id", "channel_threads.connection_id")
      .select([
        "channel_connections.id as connection_id",
        "channel_connections.name",
        "channel_connections.plugin",
        "channel_connections.agent_id",
        "channel_threads.chat_id",
        "channel_threads.thread_key",
      ])
      .where("channel_connections.org_id", "=", orgId)
      .where("channel_connections.status", "=", "active")
      .where("channel_connections.deleted_at", "is", null)
      .where("channel_threads.account_id", "=", accountId)
      .orderBy("channel_connections.name")
      .orderBy("channel_threads.chat_id")
      .execute();
    const out = new Map<string, ChatTarget>();
    for (const r of rows) {
      const chatType = r.thread_key.startsWith(DM_THREAD_PREFIX) ? "dm" : "group";
      if (chatType === "group" && this.channelFeatures(r.plugin)?.threads !== true) continue;
      const key = `${r.connection_id}\u0000${r.chat_id}\u0000${chatType}`;
      if (out.has(key)) continue;
      out.set(key, {
        connectionId: r.connection_id,
        connectionName: r.name,
        plugin: r.plugin,
        agentId: r.agent_id,
        chatId: r.chat_id,
        chatType,
        label: chatType === "dm" ? r.name : `${r.name} · ${r.chat_id}`,
      });
    }
    return [...out.values()];
  }

  /**
   * The agent's tools (connector tools included) as a task's grant picker offers them, each
   * grantable or why not by {@link grantRefusalOf}, the rule {@link addGrants} applies.
   * `agent.not_found` when the caller can't use the agent.
   */
  async grantableTools(
    orgId: string,
    accountId: string,
    agentId: string,
  ): Promise<GrantableTool[]> {
    const role = await this.liveRole(orgId, accountId);
    const agent = await this.agents.get(orgId, agentId, accountId);
    const settings = await readScheduleSettings(this.db.db, this.config, orgId);
    const d = agent.definition;
    const { tools } = await this.tools.forAgent(orgId, {
      disabledTools: d.disabledTools ?? [],
      subagentTools: d.subagentTools,
      subagents: d.subagents,
    });
    const ctx: GrantContext = {
      role,
      visibility: agent.visibility,
      skillWritePolicy: d.skills?.writePolicy,
      forbiddenTools: settings.forbiddenTools,
    };
    return tools.map((tool) => {
      const why = grantRefusalOf(tool.key, tool, ctx);
      return {
        key: tool.key,
        title: tool.spec.title ?? null,
        source: tool.source.kind,
        connectorId: tool.source.kind === "connector" ? tool.source.connectorId : null,
        grantable: why === null,
        reason: why?.code ?? null,
      };
    });
  }

  /** The task's runs, latest first (default 50, at most 200); visible as {@link get}. */
  async runs(orgId: string, actor: ScheduleActor, id: string, limit?: number): Promise<TaskRun[]> {
    const task = await this.get(orgId, actor, id);
    const n = Math.min(Math.max(Math.trunc(limit ?? RUNS_DEFAULT), 1), RUNS_MAX);
    return this.store.listRuns(this.db.db, task.id, n);
  }

  /** The task's grants; visible as {@link get}. */
  async grants(orgId: string, actor: ScheduleActor, id: string): Promise<ScheduledTaskGrantView[]> {
    const task = await this.get(orgId, actor, id);
    const grants = await this.store.listGrants(this.db.db, task.id);
    if (grants.length === 0) return [];
    // the creator's view of the agent's tools: a grant whose tool changed or left is stale
    let current = new Map<string, string>();
    try {
      const d = (await this.agents.get(orgId, task.agentId, task.accountId)).definition;
      const { tools } = await this.tools.forAgent(orgId, {
        disabledTools: d.disabledTools ?? [],
        subagentTools: d.subagentTools,
        subagents: d.subagents,
      });
      current = new Map(tools.map((x) => [x.key, x.specHash]));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "agent.not_found")) throw e;
    }
    return grants.map((g) => ({ ...g, stale: current.get(g.toolKey) !== g.specHash }));
  }

  /** Creator only; each grant is checked as at create (spec §7). */
  @Transactional()
  async addGrants(
    orgId: string,
    accountId: string,
    id: string,
    grants: GrantInput[],
  ): Promise<ScheduledTaskGrant[]> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "schedules.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    const settings = await readScheduleSettings(t, this.config, orgId);
    const agent = await this.agents.get(orgId, task.agentId, accountId);
    const resolved = await this.resolveGrants(orgId, role, agent, settings, grants);
    for (const g of resolved) await this.store.addGrant(t, task.id, g);
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "schedule.grants_changed",
      target: task.id,
      detail: { added: resolved.map((g) => g.toolKey) },
    });
    return this.store.listGrants(t, task.id);
  }

  /** Creator only; removing a grant the task does not have is a no-op. */
  @Transactional()
  async removeGrant(orgId: string, accountId: string, id: string, toolKey: string): Promise<void> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "schedules.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    if (await this.store.removeGrant(t, task.id, toolKey)) {
      await audit(t, {
        actorAccountId: accountId,
        orgId,
        action: "schedule.grants_changed",
        target: task.id,
        detail: { removed: [toolKey] },
      });
    }
  }

  /**
   * The creator's scheduled tasks that need attention (spec §8), derived live: a paused task whose
   * reason is not `creator` (resuming clears it), an active task whose latest settled non-trial
   * run failed (the next good run clears it), and a task whose latest settled non-trial run was
   * refused tools or connections (a tool granted since drops out; the next clean run clears the
   * rest). Newest first.
   */
  async attentionFor(orgId: string, accountId: string): Promise<ScheduleAttention[]> {
    const db = this.db.db;
    const tasks = (await this.store.listForAccount(db, orgId, accountId)).filter(
      (t) => t.status !== "ended",
    );
    if (tasks.length === 0) return [];
    const out: ScheduleAttention[] = [];
    const pausers = tasks.flatMap((t) =>
      t.status === "paused" && t.pausedBy !== null ? [t.pausedBy] : [],
    );
    const names = new Map<string, string>();
    if (pausers.length > 0) {
      const rows = await db
        .selectFrom("accounts")
        .select(["id", "display_name"])
        .where("id", "in", pausers)
        .execute();
      for (const r of rows) names.set(r.id, r.display_name);
    }
    const ids = tasks.map((t) => t.id);
    // the latest settled non-trial run of each task, and every grant of these tasks, in one query each
    const latest = await db
      .selectFrom("scheduled_task_runs")
      .select(["task_id", "fired_at", "scheduled_for", "missing_grants", "status", "error"])
      .distinctOn("task_id")
      .where("task_id", "in", ids)
      .where("trial", "=", false)
      .where("status", "<>", "skipped")
      .orderBy("task_id")
      .orderBy("scheduled_for", "desc")
      .orderBy("id", "desc")
      .execute();
    const runs = new Map(latest.map((r) => [r.task_id, r]));
    const grantRows = await db
      .selectFrom("scheduled_task_grants")
      .select(["task_id", "tool_key"])
      .where("task_id", "in", ids)
      .execute();
    const granted = new Map<string, Set<string>>();
    for (const g of grantRows) {
      const set = granted.get(g.task_id) ?? new Set<string>();
      set.add(g.tool_key);
      granted.set(g.task_id, set);
    }
    let loaded = false;
    let role: OrgRole | null = null;
    const gated = new Map<string, Promise<Map<string, OrgRole>>>();
    for (const task of tasks) {
      if (task.status === "paused" && task.pauseReason !== null && task.pauseReason !== "creator") {
        out.push({
          taskId: task.id,
          name: task.name,
          reason: task.pauseReason,
          pausedBy:
            task.pausedBy === null
              ? null
              : { id: task.pausedBy, name: names.get(task.pausedBy) ?? "" },
          missing: [],
          needsRole: [],
          error: null,
          at: task.updatedAt,
        });
      }
      const run = runs.get(task.id);
      if (!run) continue;
      // an active task whose latest run failed (a paused one shows its pause instead)
      if (run.status === "failed" && task.status === "active") {
        out.push({
          taskId: task.id,
          name: task.name,
          reason: "failed",
          pausedBy: null,
          missing: [],
          needsRole: [],
          error: run.error,
          at: run.fired_at ?? new Date(run.scheduled_for),
        });
      }
      const have = granted.get(task.id);
      const missing = run.missing_grants.filter((k) => !have?.has(k));
      if (missing.length === 0) continue;
      let needsRole: string[] = [];
      if (missing.some((k) => !k.startsWith("connection:"))) {
        if (!loaded) {
          role = await this.roleOrNull(orgId, accountId);
          loaded = true;
        }
        const lookup =
          gated.get(task.agentId) ?? this.requiredRoles(orgId, accountId, task.agentId);
        gated.set(task.agentId, lookup);
        const required = await lookup;
        needsRole = missing.filter((k) => {
          const req = required.get(k);
          return req !== undefined && (role === null || !roleAtLeast(role, req));
        });
      }
      out.push({
        taskId: task.id,
        name: task.name,
        reason: "missing_grants",
        pausedBy: null,
        missing,
        needsRole,
        error: null,
        at: run.fired_at ?? new Date(run.scheduled_for),
      });
    }
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  private async roleOrNull(orgId: string, accountId: string): Promise<OrgRole | null> {
    const m = await this.db.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return m?.role ?? null;
  }

  /** The agent's tools that declare a `requiredRole`, by key; none when the agent is gone or hidden. */
  private async requiredRoles(
    orgId: string,
    accountId: string,
    agentId: string,
  ): Promise<Map<string, OrgRole>> {
    let d: AgentView["definition"];
    try {
      d = (await this.agents.get(orgId, agentId, accountId)).definition;
    } catch (e) {
      // the task is paused for that reason anyway
      if (e instanceof ApiError && e.code === "agent.not_found") return new Map();
      throw e;
    }
    const { tools } = await this.tools.forAgent(orgId, {
      disabledTools: d.disabledTools ?? [],
      subagentTools: d.subagentTools,
      subagents: d.subagents,
    });
    const out = new Map<string, OrgRole>();
    for (const x of tools) if (x.requiredRole !== undefined) out.set(x.key, x.requiredRole);
    return out;
  }

  /**
   * Pauses an active live task for `reason` in the caller's transaction `t` (the fire job, the
   * delivery path); `by` is the account that caused it, null for the kernel. A task already
   * paused or ended keeps its state and reason.
   */
  async pauseFor(
    t: KernelSchemaDb,
    taskId: string,
    reason: SchedulePauseReason,
    by: string | null,
  ): Promise<void> {
    await pauseTaskIn(t, taskId, reason, by);
  }

  /**
   * "Run now" (spec §6), creator only: a task run for the request time, outside the schedule (no
   * unique-key conflict with a tick, and `next_run_at` does not move), fired at once through the
   * fire job after the commit. `trial`: an attended trial run whose approvals become the task's
   * grants (§7). Counted in the rate limit like any run. An ended task cannot run.
   */
  @Transactional()
  async runNow(
    orgId: string,
    accountId: string,
    id: string,
    opts: { trial: boolean },
  ): Promise<TaskRun> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "schedules.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    if (task.status === "ended") throw new ApiError("conflict", "This scheduled task has ended");
    const settings = await readScheduleSettings(t, this.config, orgId);
    if (!settings.enabled) throw scheduleDisabled();
    const run = await this.store.insertRun(t, {
      id: randomUUID(),
      taskId: task.id,
      orgId,
      scheduledFor: new Date(),
      trial: opts.trial,
    });
    if (!run) throw new ApiError("conflict", "The task is being run; retry");
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "schedule.run_now",
      target: task.id,
      detail: { taskRunId: run.id, trial: opts.trial },
    });
    const job = schedFireJob(run.id);
    afterCommit(async () => {
      await this.maintenance.add(job.name, job.data, job.opts);
    });
    return run;
  }

  /** The live role of a member of the org; not a member → `schedule.not_found`. */
  private async liveRole(orgId: string, accountId: string): Promise<OrgRole> {
    const m = await this.db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("orgs.deleted_at", "is", null)
      .executeTakeFirst();
    if (!m) throw scheduleNotFound();
    return m.role;
  }

  /** The actor's own task, row-locked; another's: `schedule.forbidden` for an admin, else 404. */
  private async lockOwn(
    orgId: string,
    accountId: string,
    role: OrgRole,
    id: string,
  ): Promise<ScheduledTask> {
    const task = await this.store.lockTask(this.db.db, orgId, id);
    if (!task) throw scheduleNotFound();
    if (task.accountId !== accountId) {
      throw can(role, "schedules.manage") ? scheduleForbidden() : scheduleNotFound();
    }
    return task;
  }

  /**
   * A task the actor may pause, resume or delete, row-locked under the org lock: their own (with
   * `creatorAction`), or any as an org admin (`schedules.manage`); otherwise `schedule.not_found`.
   */
  private async lockManaged(
    orgId: string,
    accountId: string,
    id: string,
    creatorAction: "org.read" | "schedules.use",
  ): Promise<{ task: ScheduledTask; byAdmin: boolean }> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "org.read");
    const task = await this.store.lockTask(this.db.db, orgId, id);
    if (!task) throw scheduleNotFound();
    if (task.accountId === accountId) {
      if (!can(role, creatorAction)) {
        throw new ApiError("forbidden", "Insufficient organization role");
      }
      return { task, byAdmin: false };
    }
    if (!can(role, "schedules.manage")) throw scheduleNotFound();
    return { task, byAdmin: true };
  }

  /**
   * Where runs go (spec §3, §8), checked against the creator:
   * - the mode and its fields agree (`conversation`: a conversation and no chat; `chat`: a chat
   *   and no conversation; `new`: neither);
   * - `conversation`: the creator's live chat conversation with this agent, still accessible;
   * - `chat`: the connection is active and bound to this agent; a DM needs a thread row (archived
   *   allowed) of the creator in that chat; a group needs the creator's thread row in the group
   *   and a channel with threads.
   */
  private async checkTarget(
    orgId: string,
    accountId: string,
    agentId: string,
    target: { mode: ScheduleMode; conversationId: string | null; chat: ScheduleChat | null },
  ): Promise<void> {
    const { mode, conversationId, chat } = target;
    if (mode === "new" && (conversationId !== null || chat !== null)) {
      throw targetInvalid("A task that starts new conversations takes no conversation or chat");
    }
    if (mode === "conversation" && (conversationId === null || chat !== null)) {
      throw targetInvalid("A conversation task needs a conversation id and no chat");
    }
    if (mode === "chat" && (chat === null || conversationId !== null)) {
      throw targetInvalid("A chat task needs a chat and no conversation id");
    }
    const t = this.db.db;
    if (mode === "conversation" && conversationId !== null) {
      const conv = await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", conversationId)
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("agent_id", "=", agentId)
        .where("kind", "=", "chat")
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!conv || !(await this.access.isAccessible(orgId, conversationId, accountId))) {
        throw targetInvalid("The conversation is not one of yours with this agent");
      }
    }
    if (mode === "chat" && chat !== null) {
      const conn = await t
        .selectFrom("channel_connections")
        .select(["plugin", "agent_id", "status"])
        .where("id", "=", chat.connectionId)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (conn?.status !== "active") {
        throw targetInvalid("The channel connection does not exist or is not active");
      }
      if (conn.agent_id !== agentId) {
        throw targetInvalid("The chat belongs to another agent: use the connection's agent");
      }
      const dm = chat.chatType === "dm";
      const thread = await t
        .selectFrom("channel_threads")
        .select("id")
        .where("connection_id", "=", chat.connectionId)
        .where("chat_id", "=", chat.chatId)
        .where("account_id", "=", accountId)
        .where("thread_key", dm ? "like" : "not like", `${DM_THREAD_PREFIX}%`)
        .limit(1)
        .executeTakeFirst();
      if (!thread) {
        throw targetInvalid(
          dm
            ? "The chat is not your direct chat with this bot; message the bot once first"
            : "You have not talked to the bot in this group",
        );
      }
      if (!dm && this.channelFeatures(conn.plugin)?.threads !== true) {
        throw targetInvalid("This channel has no threads, so a group cannot be a task's target");
      }
    }
  }

  /** The channel's declared features; undefined when its extension is not loaded here. */
  private channelFeatures(plugin: string): Channel["features"] | undefined {
    const entry = this.extensions
      .list("channel")
      .find((e) => e.plugin === plugin && e.capability === CHANNEL_EXTENSION_POINT);
    return (entry?.impl as Channel | undefined)?.features;
  }

  /**
   * A task's model, effort and device (spec §4): `new` mode only, since a conversation or chat
   * task runs with that conversation's selection and device (a task must not switch a person's
   * conversation for their later turns), so another mode refuses them (`validation_failed`).
   * The model must resolve for the org (`agent.model_unavailable`, as a message's switch) and
   * declare the effort (`validation_failed`); the device must be one of the creator's
   * (`checkDevice`, when `deviceChanged`).
   */
  private async checkPick(
    orgId: string,
    accountId: string,
    agent: AgentView,
    mode: ScheduleMode,
    pick: { model: ModelRef | null; effort: string | null; deviceId: string | null },
    deviceChanged = true,
  ): Promise<void> {
    if (mode !== "new") {
      if (pick.model !== null || pick.effort !== null || pick.deviceId !== null) {
        throw new ApiError(
          "validation_failed",
          "Only a task that starts new conversations takes a model, effort or device; a conversation or chat task runs with that conversation's",
        );
      }
      return;
    }
    if (pick.model !== null || pick.effort !== null) {
      const { info } = await this.providers.resolve(orgId, pick.model ?? agent.definition.model);
      if (pick.effort !== null) {
        const knob = info.parameters.find((p) => p.key === "effort");
        const values = (knob?.schema as { enum?: unknown[] } | undefined)?.enum ?? [];
        if (!values.includes(pick.effort)) {
          throw new ApiError("validation_failed", "Request validation failed", [
            { path: "effort", message: `The model does not offer effort "${pick.effort}"` },
          ]);
        }
      }
    }
    if (pick.deviceId !== null && deviceChanged) {
      await this.checkDevice(orgId, accountId, pick.deviceId);
    }
  }

  /** The device is one of the creator's live personal devices in the org. */
  private async checkDevice(orgId: string, accountId: string, deviceId: string): Promise<void> {
    const row = await this.db
      .selectFrom("devices")
      .select("id")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw targetInvalid("The device is not one of yours");
  }

  /**
   * The grants as stored: each tool resolved among the agent's tools now (its `spec_hash` and
   * source connector), refused by {@link grantRefusal}. Duplicates keep the last.
   */
  private async resolveGrants(
    orgId: string,
    role: OrgRole,
    agent: AgentView,
    settings: EffectiveScheduleSettings,
    grants: readonly GrantInput[],
  ): Promise<ScheduledTaskGrant[]> {
    if (grants.length === 0) return [];
    const d = agent.definition;
    const { tools } = await this.tools.forAgent(orgId, {
      disabledTools: d.disabledTools ?? [],
      subagentTools: d.subagentTools,
      subagents: d.subagents,
    });
    const out = new Map<string, ScheduledTaskGrant>();
    for (const g of grants) {
      const tool = tools.find((x) => x.key === g.toolKey);
      const why = grantRefusal(g.toolKey, tool, {
        role,
        visibility: agent.visibility,
        skillWritePolicy: d.skills?.writePolicy,
        forbiddenTools: settings.forbiddenTools,
      });
      if (why !== null || !tool) throw grantNotAllowed(why ?? `${g.toolKey} cannot be approved`);
      const connectorId = tool.source.kind === "connector" ? tool.source.connectorId : null;
      if (g.connectorId !== undefined && g.connectorId !== connectorId) {
        throw grantNotAllowed(`${g.toolKey} does not come from connector ${g.connectorId}`);
      }
      out.set(g.toolKey, { toolKey: g.toolKey, specHash: tool.specHash, connectorId });
    }
    return [...out.values()];
  }
}

/** A required text field, trimmed; empty or longer than `max` → `validation_failed`. */
function requiredText(v: string, field: string, max: number): string {
  const s = v.trim();
  if (s === "") throw new ApiError("validation_failed", `The task's ${field} is empty`);
  if (s.length > max) {
    throw new ApiError("validation_failed", `The task's ${field} is longer than ${max} characters`);
  }
  return s;
}

function withZone(t: TriggerInput, timeZone: string): ScheduleTrigger {
  return t.kind === "cron"
    ? { kind: "cron", expr: t.expr.trim(), timeZone }
    : { kind: "once", at: t.at, timeZone };
}

/**
 * The trigger is valid (spec §5) and its fire times are at least the org's interval apart; returns
 * the sampled gap (null for once), from which the jitter is derived.
 */
function checkTrigger(
  t: ScheduleTrigger,
  now: Date,
  settings: EffectiveScheduleSettings,
): number | null {
  if (!isTimeZone(t.timeZone)) {
    throw new ApiError("schedule.invalid_time_zone", `${t.timeZone} is not an IANA time zone`);
  }
  const v = validateTrigger(t, now);
  if (!v.ok) {
    const message: Record<typeof v.code, string> = {
      "schedule.invalid_cron": "The schedule is not a 5-field cron expression",
      "schedule.invalid_time_zone": `${t.timeZone} is not an IANA time zone`,
      "schedule.invalid_once_time": "The time is not a local date-time such as 2026-12-01T09:00",
      "schedule.once_in_past": "The time is not in the future",
    };
    throw new ApiError(v.code, message[v.code]);
  }
  if (t.kind === "cron") {
    if (nextTick(t, now) === null) {
      throw new ApiError("schedule.invalid_cron", "The schedule never fires");
    }
    const gap = minGapMinutes(t, now);
    if (gap !== null && gap < settings.minIntervalMinutes) {
      throw new ApiError(
        "schedule.interval_too_short",
        `The schedule fires every ${gap} minutes; this organization allows at least ${settings.minIntervalMinutes}`,
      );
    }
    return gap;
  }
  return null;
}

/** The next fire time after `now`, jitter included; null when there is none (a past once). */
function fireAt(t: ScheduleTrigger, now: Date, jitter: number): Date | null {
  const tick = nextTick(t, now);
  return tick === null ? null : new Date(tick.getTime() + jitter * 1000);
}

/**
 * A task's expiry: an explicit one must lie in the future; null (not given) is now + the org's
 * `defaultExpiryDays` for a cron task when the org sets one, else never. The same on create and
 * update, so a creator cannot clear the org's expiry policy by sending null.
 */
function expiryOf(
  v: Date | null,
  trigger: ScheduleTrigger,
  now: Date,
  settings: EffectiveScheduleSettings,
): Date | null {
  if (v !== null) return checkExpiry(v, now);
  return trigger.kind === "cron" && settings.defaultExpiryDays !== null
    ? new Date(now.getTime() + settings.defaultExpiryDays * DAY_MS)
    : null;
}

/** An expiry must lie in the future; null = never. */
function checkExpiry(v: Date | null, now: Date): Date | null {
  if (v === null) return null;
  if (Number.isNaN(v.getTime()) || v.getTime() <= now.getTime()) {
    throw new ApiError("validation_failed", "The expiry time is not in the future");
  }
  return v;
}
