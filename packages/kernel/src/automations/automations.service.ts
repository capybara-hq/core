import { randomUUID } from "node:crypto";
import {
  CHANNEL_EXTENSION_POINT,
  type Channel,
  type EventFilter,
  type LocalizedName,
  type TriggerEventDeclaration,
  type TriggerSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { AgentLookup, type AgentView } from "../agents/agent-lookup.js";
import type { ModelRef } from "../agents/definition.js";
import { ConversationAccess } from "../conversations/access.js";
import { readMessageContext } from "../conversations/message-context.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { enabledExtensionsByOrg, isExtensionEnabled } from "../extensions/enabled.js";
import { ExtensionPointDefaults } from "../extensions/point-defaults.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { loadPeople, type PersonRef } from "../identity/account-avatar.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { can, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { FORBIDDEN_TOOLS_UNREADABLE_GRANT_ERROR } from "../orgs/settings.service.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { orgHostOutsideCeiling } from "../sandbox/modes.js";
import { orgAllows } from "../sandbox/network-grants.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { isTimeZone } from "../time-zone.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  assembleCalendar,
  CALENDAR_LIMITS,
  CALENDAR_RANGE_DAYS,
  CALENDAR_TASK_RANGE_DAYS,
  type CalendarAnswer,
  type CalendarLimits,
  calendarRunReadLimit,
} from "./calendar.js";
import { type EffectiveAutomationSettings, readAutomationSettings } from "./effective-settings.js";
import {
  automationDisabled,
  automationForbidden,
  automationNotFound,
  eventSourceUnavailable,
  eventTypeUnknown,
  filterInvalid,
  grantNotAllowed,
  targetInvalid,
} from "./errors.js";
import { validateFilter } from "./events/guards.js";
import {
  GIT_GRANT_SPEC_HASH,
  GIT_PUSH_GRANT,
  type GrantContext,
  type GrantRefusalCode,
  gitGrantRefusal,
  grantRefusal,
  grantRefusalOf,
  isGitGrantKey,
  isNetworkGrantKey,
  isPolicyGrantKey,
  isTierGrantKey,
  NETWORK_GRANT_PREFIX,
  NETWORK_GRANT_SPEC_HASH,
  type NetworkGrantContext,
  networkGrantHost,
  networkGrantRefusal,
  normalizeGitGrantKey,
  tierGrantRefusal,
} from "./grant-rules.js";
import { oweAutomationFire, oweAutomationSettleUnfired } from "./job-ids.js";
import { pauseTaskIn } from "./pause.js";
import { jitterForGap, minGapMinutes, nextTick, validateTrigger } from "./schedule-math.js";
import { type AutomationPatch, AutomationStore, runOrderMoment } from "./store.js";
import type {
  Automation,
  AutomationChat,
  AutomationGrant,
  AutomationMode,
  AutomationPauseReason,
  AutomationTimeTrigger,
  AutomationTrigger,
  AutomationUnattendedAsk,
  TaskRun,
} from "./types.js";

export {
  type GrantContext,
  type GrantRefusalCode,
  grantRefusal,
  grantRefusalOf,
  networkGrantRefusal,
};

/**
 * When a task fires, before the zone is fixed (spec §5); or on events of `types` from the
 * extension `source` that match `filter` (absent: every event of the types).
 */
export type TriggerInput =
  | { kind: "cron"; expr: string }
  | { kind: "once"; at: string }
  | { kind: "event"; source: string; types: string[]; filter?: EventFilter };

/** An event trigger input. */
type EventTriggerInput = Extract<TriggerInput, { kind: "event" }>;

/** One trigger source that serves an org, as the automation form offers it. */
export interface EventSourceView {
  source: string;
  name: LocalizedName;
  events: TriggerEventDeclaration[];
}

/** An automation that needs its creator's attention (spec §8): the inbox item's payload. */
export interface AutomationAttention {
  taskId: string;
  name: string;
  /**
   * `missing_grants`: the latest run was refused tools or connections the task lacks; `failed`:
   * the latest settled run of an active task failed (its start included); else the pause reason.
   */
  reason: AutomationPauseReason | "missing_grants" | "failed";
  /** The person who paused the task (`reason: "admin"` names the admin); else null. */
  pausedBy: PersonRef | null;
  /**
   * `missing_grants` only: tool keys the latest run was refused and the task has no grant for now,
   * `connection:<slug>` (connect that connector), or `network:<host>` (a domain the run was
   * refused: the task has no grant for it, or the org's network allowlist no longer admits it).
   */
  missing: string[];
  /** The subset of `missing` the creator cannot pre-approve (the tool needs a higher role). */
  needsRole: string[];
  /**
   * The `network:<host>` keys of `missing` outside the org's network allowlist: only an org admin
   * can add the host (network ask-to-allow spec §8.3); the creator cannot pre-approve them.
   */
  needsAdmin: string[];
  /** `failed` only: the run's error; else null. */
  error: string | null;
  /** When the pause happened, or when the refused or failed run was due. */
  at: Date;
}

/**
 * A tool the creator pre-approves for the task; the service resolves its current `spec_hash`. Or a
 * domain (`toolKey: "network:<host>"`, network ask-to-allow spec §8.1): one exact host the task's
 * unattended runs may reach on the task's device, checked by `networkGrantRefusal`.
 */
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
  mode: AutomationMode;
  /** `conversation` mode only. */
  conversationId?: string;
  /** `chat` mode only. */
  chat?: AutomationChat;
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
  /** What a question in an unattended run does; absent or null: the org's default. */
  unattendedAsk?: AutomationUnattendedAsk | null;
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
  mode?: AutomationMode;
  conversationId?: string | null;
  chat?: AutomationChat | null;
  model?: ModelRef | null;
  effort?: string | null;
  deviceId?: string | null;
  expiresAt?: Date | null;
  unattendedAsk?: AutomationUnattendedAsk | null;
}

/**
 * Where a grant write comes from: `fromSession` only for a person in a signed-in web session (not a
 * personal access token, the Platform tool or the automation tools). Network domains are approved
 * only there (network ask-to-allow spec §8.1): an agent must never pre-approve a domain for itself.
 */
export interface GrantWriteSource {
  fromSession?: boolean;
}

/** The refusal of a network grant written outside a person's web session. */
const NETWORK_GRANT_NEEDS_PERSON = "Network domains are approved on the task page by a person.";

/** Why a git push grant needs a person (sandbox git credentials spec §7). */
const GIT_GRANT_NEEDS_PERSON = "Git pushes are approved on the task page by a person.";

/**
 * A grant that belongs to no tool: a network domain, a git push or a stale sandbox-level key
 * (never stale, never re-resolved).
 */
const isNonToolGrantKey = (key: string): boolean => isPolicyGrantKey(key) || isGitGrantKey(key);

/** Who acts on a task: the service reads their live role itself and decides by that one. */
export interface AutomationActor {
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

/** One of the agent's tools as the task form offers it (`GET …/automations/grantable-tools`). */
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

/**
 * A grant as the task page shows it: `stale` when the tool's definition changed or the tool left
 * (spec §7); null when the agent's tools cannot be read now.
 */
export interface AutomationGrantView extends AutomationGrant {
  stale: boolean | null;
}

/** An agent's tools by key, as {@link AutomationsService} checks grants against them. */
type AgentToolFacts = Map<string, { specHash: string; requiredRole?: OrgRole }>;

/** The latest settled (completed, failed or skipped) non-trial run of a task. */
export interface TaskLastRun {
  status: "completed" | "failed" | "skipped";
  skipReason: TaskRun["skipReason"];
  /** When it fired; its tick for a skipped one. */
  at: Date;
}

/** A task in a list, with its latest settled run. */
export type AutomationListItem = AutomationView & { lastRun: TaskLastRun | null };

/** A task with its creator as a person (null when the account is gone). */
export type AutomationView = Automation & { account: PersonRef | null };

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
 * Automations for people (spec §5, §7–§10): create, edit, pause, resume, delete, their runs
 * and grants. Every write runs in one transaction under the org row lock (`OrgLock`), which also
 * serializes the per-member and per-org caps, re-reads the actor's role there, and holds the task
 * row (`FOR UPDATE`) so the scanner skips it until the write commits.
 *
 * Roles: `automations.use` (member) creates and edits one's own tasks; `automations.manage` (admin)
 * lists, pauses, resumes and deletes any task of the org, never edits another person's (the task
 * runs as its creator). A task the caller may not see is `automation.not_found`.
 */
@Injectable()
export class AutomationsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(AutomationStore) private readonly store: AutomationStore,
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "get">,
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    @Inject(ToolRegistry) private readonly tools: Pick<ToolRegistry, "forAgent">,
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "list">,
    /** A task's model must resolve for the org and declare its effort (as a message's switch). */
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    /** "Run now" owes the fire job (consumed by the worker role). */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** Network grants: the org's sandbox-mode network (network ask-to-allow spec §8.1). */
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "ceilingLimits" | "devicePolicy">,
    /** Event automations: the trigger sources that serve an org (`trigger-source@1`). */
    @Inject(ExtensionPointDefaults)
    private readonly points: Pick<ExtensionPointDefaults, "providersFor">,
    @Inject(ExtensionDisplayNames)
    private readonly displayNames: Pick<ExtensionDisplayNames, "many">,
  ) {}

  @Transactional()
  async create(
    orgId: string,
    accountId: string,
    input: CreateTaskInput,
    browserTimeZone?: string,
    source: GrantWriteSource = {},
  ): Promise<Automation> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "automations.use");
    const t = this.db.db;
    const settings = await readAutomationSettings(t, this.config, orgId);
    if (!settings.enabled) throw automationDisabled();
    if ((await this.store.countActive(t, orgId, accountId)) >= settings.maxTasksPerMember) {
      throw new ApiError(
        "automation.limit_reached",
        `You already have ${settings.maxTasksPerMember} automations in this organization; delete one to create another`,
      );
    }
    if ((await this.store.countActive(t, orgId)) >= settings.maxTasksPerOrg) {
      throw new ApiError(
        "automation.limit_reached",
        `This organization already has ${settings.maxTasksPerOrg} automations; delete one to create another`,
      );
    }
    const name = requiredText(input.name, "name", NAME_MAX);
    const prompt = requiredText(input.prompt, "prompt", PROMPT_MAX);
    const agent = await this.agents.get(orgId, input.agentId, accountId);
    const now = new Date();
    let trigger: AutomationTrigger;
    let gap: number | null = null;
    if (input.trigger.kind === "event") {
      trigger = await this.checkEventTrigger(orgId, input.trigger, settings);
    } else {
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
      const timed = withZone(input.trigger, timeZone);
      gap = checkTrigger(timed, now, settings);
      trigger = timed;
    }
    checkModeFits(input.mode, trigger);
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
    const grants = await this.resolveGrants(
      orgId,
      role,
      agent,
      settings,
      input.grants ?? [],
      await this.taskDeviceOf(orgId, { ...target, deviceId: pick.deviceId }),
      source,
    );
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
      unattendedAsk: input.unattendedAsk ?? null,
      status: "active",
      nextRunAt: fireAt(trigger, now, jitter),
      jitterSeconds: jitter,
      expiresAt,
    });
    for (const g of grants) await this.store.addGrant(t, id, g);
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "automation.created",
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

  /** Creator only: an org admin gets `automation.forbidden`, anyone else `automation.not_found`. */
  @Transactional()
  async update(
    orgId: string,
    accountId: string,
    id: string,
    patch: UpdateTaskInput,
  ): Promise<Automation> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "automations.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    const settings = await readAutomationSettings(t, this.config, orgId);
    const now = new Date();
    const changes: AutomationPatch = {};
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
      // too (refused, so the creator sees which), and takes the new agent's definition; network
      // and git and sandbox tier grants belong to no tool and stay as they are
      const held = (await this.store.listGrants(t, task.id)).filter(
        (g) => !isNonToolGrantKey(g.toolKey),
      );
      const regranted = await this.resolveGrants(
        orgId,
        role,
        agent,
        settings,
        held.map((g) => ({
          toolKey: g.toolKey,
          ...(g.connectorId !== null && { connectorId: g.connectorId }),
        })),
        null,
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

    if (patch.trigger?.kind === "event") {
      // an event automation has no zone, tick or jitter: the next run time is cleared
      changes.trigger = await this.checkEventTrigger(orgId, patch.trigger, settings);
      changes.jitterSeconds = 0;
      changes.nextRunAt = null;
    } else if (patch.trigger !== undefined || patch.timeZone !== undefined) {
      // an event automation has no zone or tick to keep: a time trigger replacing its event
      // trigger names both
      const current = task.trigger.kind === "event" ? null : task.trigger;
      const zone = patch.timeZone ?? current?.timeZone;
      const base: TriggerInput | undefined =
        patch.trigger ??
        (current === null
          ? undefined
          : current.kind === "cron"
            ? { kind: "cron", expr: current.expr }
            : { kind: "once", at: current.at });
      if (zone === undefined || base === undefined) {
        throw new ApiError(
          "validation_failed",
          "An event automation takes a new trigger and a time zone together",
        );
      }
      const trigger = withZone(base, zone);
      const gap = checkTrigger(trigger, now, settings);
      changes.trigger = trigger;
      changes.jitterSeconds = jitterForGap(task.id, gap);
      if (task.status === "active") {
        changes.nextRunAt = fireAt(trigger, now, changes.jitterSeconds);
      }
    }
    // the mode and the trigger after the patch must fit (subject needs events, chat needs time)
    if (patch.trigger !== undefined || patch.mode !== undefined) {
      checkModeFits(target.mode, changes.trigger ?? task.trigger);
    }
    if (patch.unattendedAsk !== undefined) changes.unattendedAsk = patch.unattendedAsk;
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
      action: "automation.updated",
      target: task.id,
      detail: { fields: Object.keys(changes).sort() },
    });
    return updated;
  }

  /** The creator, or an org admin (`automations.manage`); a task not active is returned as is. */
  @Transactional()
  async pause(orgId: string, actor: AutomationActor, id: string): Promise<Automation> {
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
      action: "automation.paused",
      target: task.id,
      detail: { reason: byAdmin ? "admin" : "creator", creator: task.accountId },
    });
    return paused ?? task;
  }

  /**
   * The creator (`automations.use`), or an org admin. The next run is computed from now (missed ticks
   * are not caught up) and the failure count starts over. An ended task cannot be resumed.
   */
  @Transactional()
  async resume(orgId: string, actor: AutomationActor, id: string): Promise<Automation> {
    const { task, byAdmin } = await this.lockManaged(orgId, actor.accountId, id, "automations.use");
    if (task.status === "active") return task;
    if (task.status === "ended") throw new ApiError("conflict", "This automation has ended");
    const settings = await readAutomationSettings(this.db.db, this.config, orgId);
    if (!settings.enabled) throw automationDisabled();
    const now = new Date();
    // an event automation has no next run time
    const next =
      task.trigger.kind === "event" ? null : fireAt(task.trigger, now, task.jitterSeconds);
    if (next === null && task.trigger.kind !== "event") {
      throw new ApiError("automation.once_in_past", "The task's time has passed; set a new time");
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
      action: "automation.resumed",
      target: task.id,
      detail: { byAdmin, creator: task.accountId },
    });
    return resumed ?? task;
  }

  /** The creator, or an org admin. */
  @Transactional()
  async remove(orgId: string, actor: AutomationActor, id: string): Promise<void> {
    const { task, byAdmin } = await this.lockManaged(orgId, actor.accountId, id, "org.read");
    await this.store.softDelete(this.db.db, task.id);
    await audit(this.db.db, {
      actorAccountId: actor.accountId,
      orgId,
      action: "automation.deleted",
      target: task.id,
      detail: { byAdmin, creator: task.accountId, name: task.name },
    });
  }

  /** The creator, or an org admin. */
  async get(orgId: string, actor: AutomationActor, id: string): Promise<AutomationView> {
    const role = await this.liveRole(orgId, actor.accountId);
    const task = await this.store.getTask(this.db.db, orgId, id);
    if (!task || (task.accountId !== actor.accountId && !can(role, "automations.manage"))) {
      throw automationNotFound();
    }
    const [view] = await this.withAccounts([task]);
    return view as AutomationView;
  }

  /** Each task with its creator as a person, in one query. */
  private async withAccounts(tasks: Automation[]): Promise<AutomationView[]> {
    const people = await loadPeople(
      this.db.db,
      tasks.map((t) => t.accountId),
    );
    return tasks.map((t) => ({ ...t, account: people.get(t.accountId) ?? null }));
  }

  /** The actor's own tasks; `all` (org admins only, else `forbidden`): every task of the org. */
  async list(
    orgId: string,
    actor: AutomationActor,
    opts: { all?: boolean; conversationId?: string } = {},
  ): Promise<AutomationListItem[]> {
    const role = await this.liveRole(orgId, actor.accountId);
    let tasks: Automation[];
    if (opts.all === true) {
      if (!can(role, "automations.manage")) {
        throw new ApiError("forbidden", "Only org admins can list every automation");
      }
      tasks = await this.store.listForOrg(this.db.db, orgId);
    } else {
      tasks = await this.store.listForAccount(this.db.db, orgId, actor.accountId);
    }
    if (opts.conversationId !== undefined) {
      tasks = await this.postingInto(orgId, tasks, opts.conversationId);
    }
    return this.withLastRuns(orgId, tasks);
  }

  /**
   * The calendar between two instants (calendar spec §5): the runs and planned occurrences of the
   * actor's own tasks, or with `all` (org admins only, else `forbidden`) every task of the org; with
   * `taskId` only that task (one the actor may see, else `automation.not_found`), never collapsed.
   * Another creator's runs come without `conversationId`, `error` and `missingGrants` (§15 Q3).
   * A range longer than 43 days (2 with `taskId`), or not forward, is `validation_failed`. `now`
   * is for tests.
   */
  async calendar(
    orgId: string,
    actor: AutomationActor,
    q: { from: Date; to: Date; timeZone: string; all?: boolean; taskId?: string },
    now: Date = new Date(),
    limits: CalendarLimits = CALENDAR_LIMITS,
  ): Promise<CalendarAnswer> {
    const role = await this.liveRole(orgId, actor.accountId);
    const manage = can(role, "automations.manage");
    if (q.all === true && !manage) {
      throw new ApiError("forbidden", "Only org admins can read every automation");
    }
    const span = q.to.getTime() - q.from.getTime();
    const maxDays = q.taskId === undefined ? CALENDAR_RANGE_DAYS : CALENDAR_TASK_RANGE_DAYS;
    if (!(span > 0)) throw new ApiError("validation_failed", "from must be before to");
    if (span > maxDays * DAY_MS) {
      throw new ApiError(
        "validation_failed",
        `The range is at most ${maxDays} days${q.taskId === undefined ? "" : " with taskId"}`,
      );
    }
    const t = this.db.db;
    let tasks: Automation[];
    if (q.taskId !== undefined) {
      const task = await this.store.getTask(t, orgId, q.taskId);
      if (!task || (task.accountId !== actor.accountId && !manage)) throw automationNotFound();
      tasks = [task];
    } else {
      tasks =
        q.all === true
          ? await this.store.listForOrg(t, orgId)
          : await this.store.listForAccount(t, orgId, actor.accountId);
    }
    const runs = await this.store.listRunsBetween(
      t,
      orgId,
      tasks.map((x) => x.id),
      q.from,
      q.to,
      // one row past the caps tells the assembly where to cut
      calendarRunReadLimit(limits),
    );
    const settings = await readAutomationSettings(t, this.config, orgId);
    return assembleCalendar(
      {
        tasks,
        runs,
        viewerAccountId: actor.accountId,
        from: q.from,
        to: q.to,
        timeZone: q.timeZone,
        now,
        plan: settings.enabled,
        catchUpWindowMinutes: settings.catchUpWindowMinutes,
        collapse: q.taskId === undefined,
      },
      limits,
    );
  }

  /**
   * The tasks of `tasks` that post into the conversation: a `conversation` task naming it, or a
   * `chat` task whose chat the conversation is a thread of (spec §10 side panel).
   */
  private async postingInto(
    orgId: string,
    tasks: Automation[],
    conversationId: string,
  ): Promise<Automation[]> {
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
  private async withLastRuns(orgId: string, plain: Automation[]): Promise<AutomationListItem[]> {
    if (plain.length === 0) return [];
    const tasks = await this.withAccounts(plain);
    const rows = await this.db.db
      .selectFrom("automation_runs")
      .select(["automation_id", "status", "skip_reason", "fired_at", "scheduled_for", "created_at"])
      .distinctOn("automation_id")
      .where("org_id", "=", orgId)
      .where(
        "automation_id",
        "in",
        tasks.map((t) => t.id),
      )
      .where("trial", "=", false)
      .where("status", "in", ["completed", "failed", "skipped"])
      .orderBy("automation_id")
      .orderBy(runOrderMoment, "desc")
      .orderBy("id", "desc")
      .execute();
    const last = new Map(rows.map((r) => [r.automation_id, r]));
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
                at: runMoment(r.fired_at, r.scheduled_for, r.created_at),
              },
      };
    });
  }

  /**
   * The chats the caller can point a `chat` task at (spec §8): per active connection of the org
   * whose extension is enabled in it, their DM threads (archived included) and, on a channel with
   * threads, the groups they have a thread in. Members up (`automations.use`, the route's).
   */
  /**
   * The trigger sources that serve the org now (`trigger-source@1` providers enabled in it with a
   * valid config) and the org has not switched off (`eventSourcesOff`), each with its extension's
   * display name and event declarations: what the automation form builds its event picker and
   * filter rows from.
   */
  async eventSources(orgId: string): Promise<EventSourceView[]> {
    const settings = await readAutomationSettings(this.db.db, this.config, orgId);
    const { providers } = await this.points.providersFor<TriggerSource>(orgId, "trigger-source");
    const on = providers.filter((p) => !settings.eventSourcesOff.includes(p.extension));
    const names = await this.displayNames.many(on.map((p) => p.extension));
    return on.map((p) => ({
      source: p.extension,
      name: names.get(p.extension) ?? { zh: p.extension, en: p.extension },
      events: p.impl.events(),
    }));
  }

  /**
   * An event trigger as stored: the source must serve the org and not be switched off
   * (`automation.event_source_unavailable`), every type must be declared by it and not directed
   * (`automation.event_type_unknown`: a directed event wakes one agent through acceptance, never
   * through an automation), and the filter must fit the selected types' facts
   * (`automation.filter_invalid`).
   */
  private async checkEventTrigger(
    orgId: string,
    input: EventTriggerInput,
    settings: EffectiveAutomationSettings,
  ): Promise<AutomationTrigger> {
    const source = input.source.trim();
    const { providers } = await this.points.providersFor<TriggerSource>(orgId, "trigger-source");
    const provider = providers.find((p) => p.extension === source);
    if (provider === undefined || settings.eventSourcesOff.includes(source)) {
      throw eventSourceUnavailable(
        `${source} is not an event source of this organization (it must be an enabled extension that provides trigger events, and not switched off in the automation settings)`,
      );
    }
    const declared = provider.impl.events();
    const types = [...new Set(input.types.map((x) => x.trim()))];
    const decls: TriggerEventDeclaration[] = [];
    for (const type of types) {
      const d = declared.find((e) => e.type === type);
      if (d === undefined) {
        throw eventTypeUnknown(
          `${source} declares no event type "${type}"; it declares: ${declared.map((e) => e.type).join(", ") || "none"}`,
        );
      }
      if (d.directed) {
        throw eventTypeUnknown(
          `Event type "${type}" is directed at one agent and cannot trigger an automation`,
        );
      }
      decls.push(d);
    }
    const filter = input.filter ?? [];
    const problems = validateFilter(filter, decls);
    if (problems.length > 0) throw filterInvalid(problems.join("; "));
    return { kind: "event", source, types, filter };
  }

  async chatTargets(orgId: string, accountId: string): Promise<ChatTarget[]> {
    await this.liveRole(orgId, accountId);
    const rows = await this.db.db
      .selectFrom("channel_threads")
      .innerJoin("channel_connections", "channel_connections.id", "channel_threads.connection_id")
      .innerJoin(enabledExtensionsByOrg(this.db.db).as("en"), (j) =>
        j
          .onRef("en.org_id", "=", "channel_connections.org_id")
          .onRef("en.plugin", "=", "channel_connections.plugin"),
      )
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
    const settings = await readAutomationSettings(this.db.db, this.config, orgId);
    const d = agent.definition;
    const { tools } = await this.tools.forAgent(orgId, {
      disabledTools: d.disabledTools ?? [],
      subagentTools: d.subagentTools,
      subagents: d.subagents,
      // no conversation at hand: a web one's tools; a run elsewhere still refuses by spec.sources
      source: "web",
    });
    const ctx: GrantContext = {
      role,
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
  async runs(
    orgId: string,
    actor: AutomationActor,
    id: string,
    limit?: number,
  ): Promise<TaskRun[]> {
    const task = await this.get(orgId, actor, id);
    const n = Math.min(Math.max(Math.trunc(limit ?? RUNS_DEFAULT), 1), RUNS_MAX);
    return this.store.listRuns(this.db.db, task.id, n);
  }

  /** The task's grants; visible as {@link get}. */
  async grants(orgId: string, actor: AutomationActor, id: string): Promise<AutomationGrantView[]> {
    const task = await this.get(orgId, actor, id);
    const grants = await this.store.listGrants(this.db.db, task.id);
    if (grants.length === 0) return [];
    // the creator's view of the agent's tools: a grant whose tool changed or left is stale;
    // unknown (null) when the tools cannot be read now, rather than failing the task page
    const current = grants.every((g) => isNonToolGrantKey(g.toolKey))
      ? new Map()
      : await this.agentToolFacts(orgId, task.accountId, task.agentId);
    return grants.map((g) => ({
      ...g,
      // a network, git or sandbox tier grant names no tool definition: never stale
      stale: isNonToolGrantKey(g.toolKey)
        ? false
        : current === null
          ? null
          : current.get(g.toolKey)?.specHash !== g.specHash,
    }));
  }

  /**
   * Creator only; each grant is checked as at create (spec §7); network domains only from a web
   * session (`source.fromSession`).
   */
  @Transactional()
  async addGrants(
    orgId: string,
    accountId: string,
    id: string,
    grants: GrantInput[],
    source: GrantWriteSource = {},
  ): Promise<AutomationGrant[]> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "automations.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    const settings = await readAutomationSettings(t, this.config, orgId);
    const agent = await this.agents.get(orgId, task.agentId, accountId);
    const resolved = await this.resolveGrants(
      orgId,
      role,
      agent,
      settings,
      grants,
      await this.taskDeviceOf(orgId, task),
      source,
    );
    for (const g of resolved) await this.store.addGrant(t, task.id, g);
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "automation.grants_changed",
      target: task.id,
      detail: { added: resolved.map((g) => g.toolKey) },
    });
    return this.store.listGrants(t, task.id);
  }

  /** Creator only; removing a grant the task does not have is a no-op. */
  @Transactional()
  async removeGrant(orgId: string, accountId: string, id: string, toolKey: string): Promise<void> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "automations.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    if (await this.store.removeGrant(t, task.id, toolKey)) {
      await audit(t, {
        actorAccountId: accountId,
        orgId,
        action: "automation.grants_changed",
        target: task.id,
        detail: { removed: [toolKey] },
      });
    }
  }

  /**
   * The creator's automations that need attention (spec §8), derived live: a paused task whose
   * reason is not `creator` (resuming clears it), an active task whose latest settled non-trial
   * run failed (the next good run clears it), and a task whose latest settled non-trial run was
   * refused tools, connections or domains (a tool granted since drops out, a domain too while the
   * org's network allowlist admits it; the next clean run clears the rest). Newest first.
   */
  async attentionFor(orgId: string, accountId: string): Promise<AutomationAttention[]> {
    const db = this.db.db;
    const tasks = (await this.store.listForAccount(db, orgId, accountId)).filter(
      (t) => t.status !== "ended",
    );
    if (tasks.length === 0) return [];
    const out: AutomationAttention[] = [];
    const pausers = tasks.flatMap((t) =>
      t.status === "paused" && t.pausedBy !== null ? [t.pausedBy] : [],
    );
    const people = await loadPeople(db, pausers);
    const ids = tasks.map((t) => t.id);
    // the latest settled non-trial run of each task, and every grant of these tasks, in one query each
    const latest = await db
      .selectFrom("automation_runs")
      .select([
        "automation_id",
        "fired_at",
        "scheduled_for",
        "created_at",
        "missing_grants",
        "status",
        "error",
      ])
      .distinctOn("automation_id")
      .where("org_id", "=", orgId)
      .where("automation_id", "in", ids)
      .where("trial", "=", false)
      .where("status", "<>", "skipped")
      .orderBy("automation_id")
      .orderBy(runOrderMoment, "desc")
      .orderBy("id", "desc")
      .execute();
    const runs = new Map(latest.map((r) => [r.automation_id, r]));
    const grantRows = await db
      .selectFrom("automation_grants")
      .select(["automation_id", "tool_key", "spec_hash"])
      .where("automation_id", "in", ids)
      .execute();
    /** Per task: each granted tool key with the definition hash it was granted for. */
    const granted = new Map<string, Map<string, string>>();
    for (const g of grantRows) {
      const byKey = granted.get(g.automation_id) ?? new Map<string, string>();
      byKey.set(g.tool_key, g.spec_hash);
      granted.set(g.automation_id, byKey);
    }
    let loaded = false;
    let role: OrgRole | null = null;
    const agentTools = new Map<string, Promise<AgentToolFacts | null>>();
    // the network of the org's sandbox mode, read once and only when a refused domain needs it
    let limitsOf: Promise<NetworkGrantContext["limits"]> | undefined;
    const orgLimits = () => {
      limitsOf ??= this.sandbox.ceilingLimits(orgId);
      return limitsOf;
    };
    const toolsOf = (agentId: string) => {
      const lookup = agentTools.get(agentId) ?? this.agentToolFacts(orgId, accountId, agentId);
      agentTools.set(agentId, lookup);
      return lookup;
    };
    for (const task of tasks) {
      if (task.status === "paused" && task.pauseReason !== null && task.pauseReason !== "creator") {
        out.push({
          taskId: task.id,
          name: task.name,
          reason: task.pauseReason,
          pausedBy: task.pausedBy === null ? null : (people.get(task.pausedBy) ?? null),
          missing: [],
          needsRole: [],
          needsAdmin: [],
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
          needsAdmin: [],
          error: run.error,
          at: runMoment(run.fired_at, run.scheduled_for, run.created_at),
        });
      }
      const have = granted.get(task.id);
      const refused = run.missing_grants;
      // a refused tool granted since drops out, unless its grant no longer matches the tool's
      // definition (stale: it would be refused again); a refused domain granted since drops out
      // while the org's network allowlist admits it (network ask-to-allow spec §8.3)
      // a refused git push drops out once the task holds a grant for it or for every repository;
      // a stale sandbox-level grant can never be granted again, so it stays missing
      const isTool = (k: string) => !k.startsWith("connection:") && !isNonToolGrantKey(k);
      const facts = refused.some(isTool) ? await toolsOf(task.agentId) : null;
      const limits = refused.some(isNetworkGrantKey) ? await orgLimits() : null;
      const admits = (k: string) =>
        !isTierGrantKey(k) && limits !== null && orgAllows(networkGrantHost(k), limits);
      const missing = refused.filter((k) => {
        const hash = have?.get(k);
        if (isPolicyGrantKey(k)) return hash === undefined || !admits(k);
        if (isGitGrantKey(k)) return hash === undefined && have?.get(GIT_PUSH_GRANT) === undefined;
        if (hash === undefined) return true;
        const current = facts?.get(k);
        return facts !== null && current?.specHash !== hash;
      });
      if (missing.length === 0) continue;
      const needsAdmin = missing.filter((k) => isNetworkGrantKey(k) && !admits(k));
      let needsRole: string[] = [];
      if (facts !== null && missing.some(isTool)) {
        if (!loaded) {
          role = await this.roleOrNull(orgId, accountId);
          loaded = true;
        }
        needsRole = missing.filter((k) => {
          if (!isTool(k)) return false;
          const req = facts.get(k)?.requiredRole;
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
        needsAdmin,
        // the wire field stays for the web; no network grant is refused by a device now
        error: null,
        at: runMoment(run.fired_at, run.scheduled_for, run.created_at),
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

  /**
   * The agent's tools by key (their `requiredRole` and definition hash) as the creator sees them;
   * empty when the agent is gone or hidden (the task is paused for that anyway); null when they
   * cannot be read now (logged: the caller then cannot tell what is stale or needs a role).
   */
  private async agentToolFacts(
    orgId: string,
    accountId: string,
    agentId: string,
  ): Promise<AgentToolFacts | null> {
    try {
      const d = (await this.agents.get(orgId, agentId, accountId)).definition;
      const { tools } = await this.tools.forAgent(orgId, {
        disabledTools: d.disabledTools ?? [],
        subagentTools: d.subagentTools,
        subagents: d.subagents,
        // no conversation at hand: a web one's tools; a run elsewhere still refuses by spec.sources
        source: "web",
      });
      return new Map(
        tools.map((x) => [
          x.key,
          {
            specHash: x.specHash,
            ...(x.requiredRole !== undefined && { requiredRole: x.requiredRole }),
          },
        ]),
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent.not_found") return new Map();
      this.log.warn("automation: the agent's tools could not be read", {
        orgId,
        agentId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
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
    reason: AutomationPauseReason,
    by: string | null,
  ): Promise<void> {
    await pauseTaskIn(t, taskId, reason, by);
  }

  /**
   * "Run now" (spec §6), creator only: a task run for the request time, outside the schedule (no
   * unique-key conflict with a tick, and `next_run_at` does not move), fired at once through the
   * fire job its transaction owes. `trial`: an attended trial run whose approvals become the task's
   * grants (§7). Counted in the rate limit like any run. An ended task cannot run; a paused one
   * can (only its creator gets here: the run is `manual`, which the fire's paused check lets by).
   */
  @Transactional()
  async runNow(
    orgId: string,
    accountId: string,
    id: string,
    opts: { trial: boolean },
  ): Promise<TaskRun> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "automations.use");
    const t = this.db.db;
    const task = await this.lockOwn(orgId, accountId, role, id);
    if (task.status === "ended") throw new ApiError("conflict", "This automation has ended");
    const settings = await readAutomationSettings(t, this.config, orgId);
    if (!settings.enabled) throw automationDisabled();
    const run = await this.store.insertRun(t, {
      id: randomUUID(),
      taskId: task.id,
      orgId,
      scheduledFor: new Date(),
      trial: opts.trial,
      manual: true,
    });
    if (!run) throw new ApiError("conflict", "The task is being run; retry");
    await audit(t, {
      actorAccountId: accountId,
      orgId,
      action: "automation.run_now",
      target: task.id,
      detail: { taskRunId: run.id, trial: opts.trial },
    });
    await oweAutomationFire(this.outbox, run.id, orgId);
    // a fire job that fails for good before its claim leaves the run to this check (`removed`)
    await oweAutomationSettleUnfired(this.outbox, run.id, orgId, run.scheduledFor, null);
    return run;
  }

  /** The live role of a member of the org; not a member → `automation.not_found`. */
  private async liveRole(orgId: string, accountId: string): Promise<OrgRole> {
    const m = await this.db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("orgs.deleted_at", "is", null)
      .executeTakeFirst();
    if (!m) throw automationNotFound();
    return m.role;
  }

  /** The actor's own task, row-locked; another's: `automation.forbidden` for an admin, else 404. */
  private async lockOwn(
    orgId: string,
    accountId: string,
    role: OrgRole,
    id: string,
  ): Promise<Automation> {
    const task = await this.store.lockTask(this.db.db, orgId, id);
    if (!task) throw automationNotFound();
    if (task.accountId !== accountId) {
      throw can(role, "automations.manage") ? automationForbidden() : automationNotFound();
    }
    return task;
  }

  /**
   * A task the actor may pause, resume or delete, row-locked under the org lock: their own (with
   * `creatorAction`), or any as an org admin (`automations.manage`); otherwise `automation.not_found`.
   */
  private async lockManaged(
    orgId: string,
    accountId: string,
    id: string,
    creatorAction: "org.read" | "automations.use",
  ): Promise<{ task: Automation; byAdmin: boolean }> {
    const { role } = await this.orgLock.lockAndAuthorize(orgId, accountId, "org.read");
    const task = await this.store.lockTask(this.db.db, orgId, id);
    if (!task) throw automationNotFound();
    if (task.accountId === accountId) {
      if (!can(role, creatorAction)) {
        throw new ApiError("forbidden", "Insufficient organization role");
      }
      return { task, byAdmin: false };
    }
    if (!can(role, "automations.manage")) throw automationNotFound();
    return { task, byAdmin: true };
  }

  /**
   * Where runs go (spec §3, §8), checked against the creator:
   * - the mode and its fields agree (`conversation`: a conversation and no chat; `chat`: a chat
   *   and no conversation; `new`: neither);
   * - `conversation`: the creator's live chat conversation with this agent, still accessible;
   * - `chat`: the connection is active, its channel extension is enabled in this org, and it is
   *   bound to this agent; a DM needs a thread row (archived allowed) of the creator in that chat;
   *   a group needs the creator's thread row in the group and a channel with threads.
   */
  private async checkTarget(
    orgId: string,
    accountId: string,
    agentId: string,
    target: { mode: AutomationMode; conversationId: string | null; chat: AutomationChat | null },
  ): Promise<void> {
    const { mode, conversationId, chat } = target;
    if (mode === "new" && (conversationId !== null || chat !== null)) {
      throw targetInvalid("A task that starts new conversations takes no conversation or chat");
    }
    if (mode === "subject" && (conversationId !== null || chat !== null)) {
      throw targetInvalid(
        "A task that opens a conversation per subject takes no conversation or chat",
      );
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
      if (!(await isExtensionEnabled(t, orgId, conn.plugin))) {
        throw targetInvalid(
          "The channel's extension is disabled in this organization, so its chats cannot receive a task's runs",
        );
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
    mode: AutomationMode,
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
   * source connector), refused by {@link grantRefusal}; each `network:<host>` key (lower-cased)
   * refused by {@link networkGrantRefusal} against the org's effective egress and the summary of
   * `deviceId`, the task's device (null: none can be determined, the device rule is skipped),
   * stored with `spec_hash` `network` and no connector (plan P-D7), and only when
   * `source.fromSession` (a person on the task page; never a token, the Platform tool or the
   * automation tools). Each git push key (`git:push`, `git:push:<owner>/<repo>`, the repository
   * lower-cased) is refused by {@link gitGrantRefusal} and stored with `spec_hash` `git` and no
   * connector, also only when `source.fromSession`. Duplicates keep the last.
   */
  private async resolveGrants(
    orgId: string,
    role: OrgRole,
    agent: AgentView,
    settings: EffectiveAutomationSettings,
    grants: readonly GrantInput[],
    _deviceId: string | null,
    source: GrantWriteSource = {},
  ): Promise<AutomationGrant[]> {
    if (grants.length === 0) return [];
    // fail closed: no grant can be checked against a list that cannot be read
    if (settings.forbiddenToolsUnreadable) {
      throw grantNotAllowed(FORBIDDEN_TOOLS_UNREADABLE_GRANT_ERROR);
    }
    const out = new Map<string, AutomationGrant>();
    const network = grants.filter((g) => isNetworkGrantKey(g.toolKey));
    if (network.length > 0) {
      if (source.fromSession !== true) throw grantNotAllowed(NETWORK_GRANT_NEEDS_PERSON);
      const ctx = await this.networkGrantContext(orgId);
      for (const g of network) {
        if (g.connectorId !== undefined) {
          throw grantNotAllowed(`${g.toolKey} is a domain and comes from no connector`);
        }
        const host = networkGrantHost(g.toolKey).trim().toLowerCase().replace(/\.$/, "");
        const why = networkGrantRefusal(host, ctx);
        if (why !== null) throw grantNotAllowed(why.message);
        const toolKey = `${NETWORK_GRANT_PREFIX}${host}`;
        out.set(toolKey, { toolKey, specHash: NETWORK_GRANT_SPEC_HASH, connectorId: null });
      }
    }
    const git = grants.filter((g) => isGitGrantKey(g.toolKey));
    if (git.length > 0) {
      // a push is the creator's decision, never an agent's or a token's (as network domains)
      if (source.fromSession !== true) throw grantNotAllowed(GIT_GRANT_NEEDS_PERSON);
      for (const g of git) {
        if (g.connectorId !== undefined) {
          throw grantNotAllowed(`${g.toolKey} is a git push and comes from no connector`);
        }
        const toolKey = normalizeGitGrantKey(g.toolKey);
        const why = gitGrantRefusal(toolKey, { forbiddenTools: settings.forbiddenTools });
        if (why !== null) throw grantNotAllowed(why.message);
        out.set(toolKey, { toolKey, specHash: GIT_GRANT_SPEC_HASH, connectorId: null });
      }
    }
    const tiers = grants.filter((g) => isTierGrantKey(g.toolKey));
    for (const g of tiers) {
      if (g.connectorId !== undefined) {
        throw grantNotAllowed(`${g.toolKey} is a sandbox level and comes from no connector`);
      }
      // a stale tier:<...> grant from before auto mode: no tier can be granted now
      const why = tierGrantRefusal(g.toolKey);
      if (why !== null) throw grantNotAllowed(why.message);
    }
    const toolGrants = grants.filter((g) => !isNonToolGrantKey(g.toolKey));
    if (toolGrants.length === 0) return [...out.values()];
    const d = agent.definition;
    const { tools } = await this.tools.forAgent(orgId, {
      disabledTools: d.disabledTools ?? [],
      subagentTools: d.subagentTools,
      subagents: d.subagents,
      // no conversation at hand: a web one's tools; a run elsewhere still refuses by spec.sources
      source: "web",
    });
    for (const g of toolGrants) {
      const tool = tools.find((x) => x.key === g.toolKey);
      const why = grantRefusal(g.toolKey, tool, {
        role,
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

  /**
   * What a network grant is checked against (network ask-to-allow spec §8.1): the network of the
   * org's sandbox mode now (auto mode spec §4.2).
   */
  private async networkGrantContext(orgId: string): Promise<NetworkGrantContext> {
    const limits = await this.sandbox.ceilingLimits(orgId);
    const platform = this.config.get().sandbox.limits;
    return { limits, outsideCeiling: (h) => orgHostOutsideCeiling(platform, h) };
  }

  /**
   * The device a task's runs use, as far as the task tells: a `new` task's own device, a
   * `conversation` task's conversation's device (in the org); null when none is chosen, and for a
   * chat task: its IM conversation's device is not known until it runs.
   */
  private async taskDeviceOf(
    orgId: string,
    task: {
      mode: AutomationMode;
      deviceId: string | null;
      conversationId: string | null;
    },
  ): Promise<string | null> {
    if (task.mode === "new") return task.deviceId;
    if (task.mode !== "conversation" || task.conversationId === null) return null;
    const c = await this.db.db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", task.conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    return c?.device_id ?? null;
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

/**
 * When a run happened, for lists: its fire time, else its tick, else when it was recorded (an
 * event run has no tick and no fire time before its claim).
 */
function runMoment(
  firedAt: Date | string | null,
  scheduledFor: Date | string | null,
  createdAt: Date | string,
): Date {
  return new Date(firedAt ?? scheduledFor ?? createdAt);
}

/**
 * The mode must fit the trigger: `subject` (one conversation per event subject) needs an event
 * trigger, and an event automation does not post into an IM chat yet (`chat` is a time
 * automation's mode).
 */
function checkModeFits(mode: AutomationMode, trigger: AutomationTrigger): void {
  if (mode === "subject" && trigger.kind !== "event") {
    throw targetInvalid(
      "Mode subject (one conversation per event subject) needs an event trigger; use new, conversation or chat with a schedule",
    );
  }
  if (mode === "chat" && trigger.kind === "event") {
    throw targetInvalid(
      "An event automation cannot post into an IM chat yet; use mode new, conversation or subject",
    );
  }
}

function withZone(
  t: Exclude<TriggerInput, { kind: "event" }>,
  timeZone: string,
): AutomationTimeTrigger {
  return t.kind === "cron"
    ? { kind: "cron", expr: t.expr.trim(), timeZone }
    : { kind: "once", at: t.at, timeZone };
}

/**
 * The trigger is valid (spec §5) and its fire times are at least the org's interval apart; returns
 * the sampled gap (null for once), from which the jitter is derived.
 */
function checkTrigger(
  t: AutomationTimeTrigger,
  now: Date,
  settings: EffectiveAutomationSettings,
): number | null {
  if (!isTimeZone(t.timeZone)) {
    throw new ApiError("automation.invalid_time_zone", `${t.timeZone} is not an IANA time zone`);
  }
  const v = validateTrigger(t, now);
  if (!v.ok) {
    const message: Record<typeof v.code, string> = {
      "automation.invalid_cron": "The schedule is not a 5-field cron expression",
      "automation.invalid_time_zone": `${t.timeZone} is not an IANA time zone`,
      "automation.invalid_once_time": "The time is not a local date-time such as 2026-12-01T09:00",
      "automation.once_in_past": "The time is not in the future",
    };
    throw new ApiError(v.code, message[v.code]);
  }
  if (t.kind === "cron") {
    if (nextTick(t, now) === null) {
      throw new ApiError("automation.invalid_cron", "The schedule never fires");
    }
    const gap = minGapMinutes(t, now);
    if (gap !== null && gap < settings.minIntervalMinutes) {
      throw new ApiError(
        "automation.interval_too_short",
        `The schedule fires every ${gap} minutes; this organization allows at least ${settings.minIntervalMinutes}`,
      );
    }
    return gap;
  }
  return null;
}

/** The next fire time after `now`, jitter included; null when there is none (a past once). */
function fireAt(t: AutomationTrigger, now: Date, jitter: number): Date | null {
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
  trigger: AutomationTrigger,
  now: Date,
  settings: EffectiveAutomationSettings,
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
