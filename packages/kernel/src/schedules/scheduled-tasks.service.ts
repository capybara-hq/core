import { randomUUID } from "node:crypto";
import { CHANNEL_EXTENSION_POINT, type Channel } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { AgentLookup, type AgentView } from "../agents/agent-lookup.js";
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
  model?: string;
  effort?: string;
  deviceId?: string;
  /**
   * When the task ends; it must lie in the future. Absent or null: for a cron task, now + the
   * org's `defaultExpiryDays` when set; otherwise never.
   */
  expiresAt?: Date | null;
  grants?: GrantInput[];
}

/** Fields to change; `null` clears an optional one. Grants change through their own methods. */
export interface UpdateTaskInput {
  agentId?: string;
  name?: string;
  prompt?: string;
  trigger?: TriggerInput;
  timeZone?: string;
  mode?: ScheduleMode;
  conversationId?: string | null;
  chat?: ScheduleChat | null;
  model?: string | null;
  effort?: string | null;
  deviceId?: string | null;
  expiresAt?: Date | null;
}

/**
 * Who acts on a task. `role` is what the caller saw; the service re-reads the live role inside
 * its transaction and decides by that one.
 */
export interface ScheduleActor {
  accountId: string;
  role: OrgRole;
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
  ctx: {
    role: OrgRole;
    visibility: AgentView["visibility"];
    skillWritePolicy?: "allow" | "ask" | undefined;
    forbiddenTools: readonly string[];
  },
): string | null {
  if (ctx.forbiddenTools.includes(toolKey)) {
    return `The organization does not allow ${toolKey} in scheduled runs`;
  }
  if (toolKey === BUILTIN.SkillWrite) {
    return `${toolKey} cannot be approved for a scheduled task: an unattended run never changes the agent's skills`;
  }
  if (!tool) return `${toolKey} is not one of the agent's tools now`;
  if (tool.requiredRole !== undefined && !roleAtLeast(ctx.role, tool.requiredRole)) {
    return `${toolKey} needs the ${tool.requiredRole} role to approve; you cannot approve it for the task`;
  }
  if (isFixedAsk(tool, ctx.visibility, ctx.skillWritePolicy)) {
    return `${toolKey} always asks a person and cannot be approved in advance`;
  }
  return null;
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
    if (input.deviceId !== undefined) await this.checkDevice(orgId, accountId, input.deviceId);
    const expiresAt =
      input.expiresAt != null
        ? checkExpiry(input.expiresAt, now)
        : trigger.kind === "cron" && settings.defaultExpiryDays !== null
          ? new Date(now.getTime() + settings.defaultExpiryDays * DAY_MS)
          : null;
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
      model: input.model ?? null,
      effort: input.effort ?? null,
      deviceId: input.deviceId ?? null,
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
    if (patch.agentId !== undefined && patch.agentId !== task.agentId) {
      const agent = await this.agents.get(orgId, patch.agentId, accountId);
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
    if (patch.model !== undefined) changes.model = patch.model;
    if (patch.effort !== undefined) changes.effort = patch.effort;
    if (patch.deviceId !== undefined) {
      if (patch.deviceId !== null) await this.checkDevice(orgId, accountId, patch.deviceId);
      changes.deviceId = patch.deviceId;
    }
    if (patch.expiresAt !== undefined) changes.expiresAt = checkExpiry(patch.expiresAt, now);

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
    opts: { all?: boolean } = {},
  ): Promise<ScheduledTask[]> {
    const role = await this.liveRole(orgId, actor.accountId);
    if (opts.all === true) {
      if (!can(role, "schedules.manage")) {
        throw new ApiError("forbidden", "Only org admins can list every scheduled task");
      }
      return this.store.listForOrg(this.db.db, orgId);
    }
    return this.store.listForAccount(this.db.db, orgId, actor.accountId);
  }

  /** The task's runs, latest first (default 50, at most 200); visible as {@link get}. */
  async runs(orgId: string, actor: ScheduleActor, id: string, limit?: number): Promise<TaskRun[]> {
    const task = await this.get(orgId, actor, id);
    const n = Math.min(Math.max(Math.trunc(limit ?? RUNS_DEFAULT), 1), RUNS_MAX);
    return this.store.listRuns(this.db.db, task.id, n);
  }

  /** The task's grants; visible as {@link get}. */
  async grants(orgId: string, actor: ScheduleActor, id: string): Promise<ScheduledTaskGrant[]> {
    const task = await this.get(orgId, actor, id);
    return this.store.listGrants(this.db.db, task.id);
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

/** An expiry must lie in the future; null = never. */
function checkExpiry(v: Date | null, now: Date): Date | null {
  if (v === null) return null;
  if (Number.isNaN(v.getTime()) || v.getTime() <= now.getTime()) {
    throw new ApiError("validation_failed", "The expiry time is not in the future");
  }
  return v;
}
