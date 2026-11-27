import type { ChannelTarget, TriggerSubject } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { AgentLookup, AgentLookupModule } from "../agents/agent-lookup.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { ChannelConnections } from "../channels/connections.service.js";
import { findOrBindThread, findThread, type ThreadKey } from "../channels/threads.js";
import { ConversationAccess, ConversationAccessModule } from "../conversations/access.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import {
  ConversationsService,
  type InternalMessageOptions,
} from "../conversations/conversations.service.js";
import { ConversationQueue } from "../conversations/queue.service.js";
import { channelSource } from "../conversations/source.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { DialInRelay } from "../dial-in/relay.js";
import { DialInRelayModule } from "../dial-in/relay.module.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock, OrgLockModule } from "../orgs/org-lock.js";
import { FORBIDDEN_TOOLS_UNREADABLE_ERROR } from "../orgs/settings.service.js";
import { AUTOMATION_EVENT_HEAD, AUTOMATION_EVENT_TAIL } from "../runtime/context/run-context.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { DeviceProviders, servesDialIn } from "../sandbox/providers.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { readAutomationSettings } from "./effective-settings.js";
import {
  AUTOMATION_LATE_FIRE_SLACK_MS,
  AUTOMATION_SETTLE_AFTER_MS,
  AUTOMATION_SETTLE_LONG_CHECKS,
  AUTOMATION_SETTLE_RECHECK_MS,
  type AutomationSettleJobData,
  oweAutomationSettle,
} from "./job-ids.js";
import { pauseTaskIn } from "./pause.js";
import { AutomationRunTracker, AutomationTrackerModule, lockTaskRow } from "./run-tracker.js";
import { AutomationScanJob } from "./scan.job.js";
import { AutomationStore } from "./store.js";
import { AutomationStoreModule } from "./store.module.js";
import type {
  Automation,
  AutomationEventMarker,
  AutomationPauseReason,
  ScheduleMarker,
  TaskRun,
  TaskRunSkipReason,
} from "./types.js";

/** A task run's message client id in a conversation's queue (never read back as "the task's"). */
export const automationClientMessageId = (taskRunId: string): string => `automation-${taskRunId}`;

const HOUR_MS = 3_600_000;
/** How many stale previous runs the overlap check releases before it gives up. */
const OVERLAP_SETTLE_MAX = 5;

/** The skips that last: the task pauses with the same reason (spec §6). */
const LASTING: ReadonlySet<TaskRunSkipReason> = new Set<TaskRunSkipReason>([
  "org_disabled",
  "creator_inactive",
  "agent_gone",
  "conversation_gone",
  "target_gone",
]);

/**
 * What starting a claimed task run does, by the task's mode. `event`: an event run's marker
 * (collaboration spec §4.6), read from its deliveries at the claim; absent for a time run.
 */
type StartPlan = { task: Automation; run: TaskRun; event?: AutomationEventMarker } & (
  | { mode: "new" }
  | { mode: "conversation"; conversationId: string }
  | { mode: "chat"; thread: ThreadKey; target: ChannelTarget }
  | { mode: "group"; connectionId: string; chatId: string }
  /** One conversation per subject (collaboration spec §4.5): the subject of the run's events. */
  | { mode: "subject"; subject: Pick<TriggerSubject, "kind" | "id" | "title"> }
);

/** Why a claim refused the run (a skip), or the plan to start it. */
type ClaimResult = { skip: TaskRunSkipReason } | { plan: StartPlan } | null;

/** The tick in the task's zone as the run's header shows it: `2026-11-11 09:00 (Asia/Shanghai)`. */
export function localTimeOf(at: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${timeZone})`;
}

const DEVICE_GONE = new Set(["device.not_found", "device.unavailable", "sandbox.unavailable"]);

/**
 * Checks and starts one task run (scheduled tasks spec §6), the body of the `automation-fire-<id>` job.
 * Idempotent on the task run: only a `pending` one is fired. Two steps:
 *
 * 1. The claim, one transaction under the org row lock (which serializes the org's rate limit
 *    count), then the task run and the task rows: the checks in order (task paused since the
 *    scan, unless a person's "run now"; a tick fired more than 10 minutes past the org's catch-up
 *    window, `missed`, unless a "run now"; org disabled, creator inactive or not a member, agent
 *    gone or not visible, conversation gone, connection inactive or its extension disabled in the
 *    org, overlap, rate limit, device offline, queue paused), each a `skipped` run with its reason,
 *    the lasting ones also pausing the task; then `fired_at` is written, after the rate limit count,
 *    with the run's delayed settle check owed (`automation-settle`, {@link settle}).
 *    A run whose claim committed before (a retried job) goes straight to the start.
 * 2. The start, idempotent: `new` creates the conversation with its first message keyed by the
 *    task run id (`create_request_id`); `conversation` queues the prompt in the target
 *    conversation's queue (never absorbed into a run in progress); `chat` finds the DM's live
 *    thread or creates and binds a conversation (one transaction), then queues the prompt there;
 *    a group chat gets a new conversation per run whose thread outbound binds at the run's first
 *    post (`openGroup`); `subject` finds the subject's conversation (`automation_conversations`)
 *    or creates and maps one (one transaction, `bindSubject`), then queues the prompt there. A
 *    start that finds the target gone takes `fired_at` back and skips the run.
 *
 * A time run's message carries the schedule marker and the task's zone; an event run's carries
 * the event marker (its events, from `automation_event_deliveries`; collaboration spec §4.6). The
 * kernel run its message triggers takes the task run (`linkStartedRunIn`), and the run tracker
 * follows it to its end. An event run skips the overlap check (its events would be lost): a `new`
 * run gets its own conversation, and a `conversation` or `subject` run is queued into its
 * conversation, whose queue serializes the runs. The rate limit counts the owner's runs.
 */
@Injectable()
// org-filter: the automation-fire / automation-settle job handler (worker only): the task run id is the
// kernel-written job payload, and every other id is read from that run's own task row
export class AutomationFirer {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(AutomationStore) private readonly store: AutomationStore,
    @Inject(AutomationRunTracker)
    private readonly tracker: Pick<AutomationRunTracker, "inFlightIn" | "failStartIn">,
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "tryLock">,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "get">,
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    @Inject(ConversationsService)
    private readonly conversations: Pick<ConversationsService, "createWithMessage" | "create">,
    @Inject(ConversationQueue) private readonly queue: Pick<ConversationQueue, "add">,
    @Inject(ChannelConnections)
    private readonly connections: Pick<ChannelConnections, "row" | "channel">,
    /** Whether a dial-in device's machine is connected now. */
    @Inject(DialInRelay) private readonly relay: Pick<DialInRelay, "online">,
    /** Each device's provider (whether it serves its devices over the dial-in channel). */
    @Inject(DeviceProviders) private readonly providers: Pick<DeviceProviders, "forDevice">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn" | "info">,
    /** The claim owes the run's settle check (ruling R26). */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** Fires task run `taskRunId` (see the class); a run not `pending` is left as it is. */
  async fire(taskRunId: string): Promise<void> {
    const pre = await this.db
      .selectFrom("automation_runs as r")
      .innerJoin("automations as t", "t.id", "r.automation_id")
      .select(["r.status", "r.org_id", "r.fired_at", "t.device_id", "t.mode"])
      .where("r.id", "=", taskRunId)
      .executeTakeFirst();
    if (pre?.status !== "pending") return;
    // a Redis read: outside the claim's transaction; only a `new` task takes a device
    const offline =
      pre.fired_at === null && pre.device_id !== null && pre.mode === "new"
        ? await this.deviceOffline(pre.org_id, pre.device_id)
        : false;
    const claimed = await this.claim(taskRunId, pre.org_id, offline);
    if (claimed === null || "skip" in claimed) return;
    await this.start(claimed.plan);
  }

  /**
   * The `automation-settle` job (ruling R26; `job-ids.ts`). The claimed check: a task run claimed
   * (`fired_at`) and still `pending` goes through the run tracker's check, which links it to its
   * run, settles it, or releases a run that left no trace (`skipped`, `removed`), so a `once`
   * task's last run never stays pending; one still in flight (its item queued, its message posted)
   * owes the next check an hour on. The unfired check: a run still `pending` that no claim took
   * (its fire job failed for good before the claim) is skipped, `missed` for a tick, `removed` for
   * a "run now", so the overlap check never waits on it. A run claimed, started, ended or skipped
   * since is left as it is (the claimed check follows a claimed run).
   */
  @Transactional()
  async settle(data: AutomationSettleJobData): Promise<void> {
    const { taskRunId } = data;
    if ("unfired" in data) {
      await this.settleUnfired(taskRunId);
      return;
    }
    const run = await this.store.updateRun(this.db, taskRunId, {});
    if (run?.status !== "pending" || run.firedAt === null) return;
    // inFlightIn takes the task row before the run (the one lock order)
    if (!(await this.tracker.inFlightIn(run))) return;
    const now = await this.store.updateRun(this.db, taskRunId, {});
    if (now?.status !== "pending" || now.firedAt === null) return;
    const next = data.check + 1;
    if (next === AUTOMATION_SETTLE_LONG_CHECKS) {
      this.log.warn("automation run still in flight a week after its claim", {
        taskId: run.taskId,
        taskRunId,
      });
    }
    await oweAutomationSettle(
      this.outbox,
      taskRunId,
      run.orgId,
      next,
      AUTOMATION_SETTLE_RECHECK_MS,
    );
  }

  /** The unfired check (see {@link settle}), task row first (the one lock order). */
  private async settleUnfired(taskRunId: string): Promise<void> {
    const t = this.db;
    const owner = await t
      .selectFrom("automation_runs")
      .select("automation_id")
      .where("id", "=", taskRunId)
      .executeTakeFirst();
    if (!owner) return;
    await lockTaskRow(t, owner.automation_id);
    const run = await t
      .selectFrom("automation_runs")
      .select(["status", "fired_at", "manual"])
      .where("id", "=", taskRunId)
      .forUpdate()
      .executeTakeFirst();
    if (run?.status !== "pending" || run.fired_at !== null) return;
    await this.skipIn(t, taskRunId, owner.automation_id, run.manual ? "removed" : "missed");
  }

  /** Step 1 (see the class): a skip, the plan, or null when there is nothing to fire. */
  @Transactional()
  private async claim(
    taskRunId: string,
    orgId: string,
    deviceOffline: boolean,
  ): Promise<ClaimResult> {
    const t = this.db;
    // the org row first, as every task write does (AutomationsService): no lock cycle
    if ((await this.orgLock.tryLock(orgId)) === undefined) return null;
    const owner = await t
      .selectFrom("automation_runs")
      .select("automation_id")
      .where("id", "=", taskRunId)
      .executeTakeFirst();
    if (!owner) return null;
    // lock order org → task row → task runs, as the run tracker and the service take them
    await lockTaskRow(t, owner.automation_id);
    const row = await t
      .selectFrom("automation_runs")
      .select("id")
      .where("id", "=", taskRunId)
      .forUpdate()
      .executeTakeFirst();
    const run = row ? await this.store.updateRun(t, taskRunId, {}) : null;
    if (run?.status !== "pending") return null;
    const task = await this.store.getTask(t, orgId, run.taskId);
    if (!task) {
      await this.store.updateRun(t, run.id, {
        status: "skipped",
        skipReason: "task_deleted",
        firedAt: null,
      });
      return null;
    }
    const resumed = run.firedAt !== null;
    const skip = async (reason: TaskRunSkipReason): Promise<ClaimResult> => {
      await this.skipIn(t, run.id, task.id, reason);
      return { skip: reason };
    };

    // paused after the scan recorded the tick: only a person's "run now" still runs
    if (!resumed && !run.manual && task.status === "paused") return skip("task_paused");
    const settings = await readAutomationSettings(t, this.config, orgId);
    // a tick whose fire comes this late (workers down for long) is missed, as the scan records a
    // tick it finds outside the window; a person's "run now" still runs
    const lateAfter = settings.catchUpWindowMinutes * 60_000 + AUTOMATION_LATE_FIRE_SLACK_MS;
    // an event run has no tick and is never missed (collaboration spec §4.1)
    if (
      !resumed &&
      !run.manual &&
      run.scheduledFor !== null &&
      Date.now() - run.scheduledFor.getTime() > lateAfter
    ) {
      return skip("missed");
    }
    if (!resumed && !settings.enabled) return skip("org_disabled");
    // an unattended run must not run with nothing forbidden (a trial run is attended)
    if (!resumed && !run.trial && settings.forbiddenToolsUnreadable) {
      this.log.warn("automation run failed: the org's forbidden tool list is unreadable", {
        orgId,
        taskId: task.id,
        taskRunId: run.id,
      });
      await this.tracker.failStartIn(run.id, FORBIDDEN_TOOLS_UNREADABLE_ERROR);
      return null;
    }
    if (!resumed && !(await this.creatorActive(orgId, task.accountId))) {
      return skip("creator_inactive");
    }
    if (!resumed) {
      try {
        await this.agents.get(orgId, task.agentId, task.accountId);
      } catch (e) {
        if (e instanceof ApiError && e.code === "agent.not_found") return skip("agent_gone");
        throw e;
      }
    }

    let event: AutomationEventMarker | undefined;
    if (task.trigger.kind === "event") {
      event = await this.eventMarkerOf(task, run.id, task.trigger.source);
      if (event === undefined) {
        // the coalescer links a run's deliveries in the transaction that inserts it
        this.log.warn("event automation run has no events", { taskId: task.id, taskRunId: run.id });
        await this.tracker.failStartIn(run.id, "The run's events are gone");
        return null;
      }
    }
    let plan: StartPlan;
    let queuePausedOn: string | undefined;
    if (task.mode === "subject") {
      const first = event?.events[0];
      if (first === undefined) return skip("unsupported_target");
      plan = { mode: "subject", task, run, subject: first.subject };
      const mapped = await this.subjectConversation(task, first.subject);
      if (mapped?.queuePaused) queuePausedOn = mapped.id;
    } else if (task.mode === "conversation") {
      const conv = await this.targetConversation(task);
      if (conv === undefined) return skip("conversation_gone");
      plan = { mode: "conversation", task, run, conversationId: conv.id };
      if (conv.queuePaused) queuePausedOn = conv.id;
    } else if (task.mode === "chat") {
      const chat = task.chat;
      const conn = chat === null ? undefined : await this.connections.row(chat.connectionId);
      if (
        chat === null ||
        !conn ||
        conn.orgId !== orgId ||
        conn.status !== "active" ||
        conn.agentId !== task.agentId
      ) {
        return skip("target_gone");
      }
      // the org switched the channel's extension off: the task stays active and recovers when it
      // is switched on again (unlike a target that is gone)
      if (!conn.pluginEnabled) return skip("plugin_disabled");
      if (chat.chatType === "group") {
        // a group has no current conversation: each run starts its own thread at its first post
        // (spec §8), which needs a channel with threads; the creator must have written there
        if (!this.connections.channel(conn.plugin).features.threads) {
          return skip("unsupported_target");
        }
        if (!(await this.inGroup(chat.connectionId, chat.chatId, task.accountId))) {
          return skip("target_gone");
        }
        plan = { mode: "group", task, run, connectionId: chat.connectionId, chatId: chat.chatId };
      } else {
        const threadKey = await this.dmThreadKey(conn, chat.chatId, task.accountId);
        if (threadKey === undefined) return skip("target_gone");
        const thread: ThreadKey = {
          connectionId: chat.connectionId,
          chatId: chat.chatId,
          threadKey,
          accountId: task.accountId,
        };
        plan = { mode: "chat", task, run, thread, target: { chatId: chat.chatId, chatType: "dm" } };
        const live = await findThread(t, thread);
        if (live !== undefined && (await this.queuePaused(live))) queuePausedOn = live;
      }
    } else {
      plan = { mode: "new", task, run };
    }
    if (event !== undefined) plan = { ...plan, event };
    if (resumed) return { plan };

    // an event run never waits for another run of its automation (collaboration spec §4.7): its
    // events would be lost; `new` gives each run its own conversation, and `conversation` and
    // `subject` queue it into the conversation, whose queue serializes the runs
    if (event === undefined && (await this.overlaps(task.id, run.id))) return skip("overlap");
    // the owner's runs across their automations (collaboration spec §4.7: per person)
    const fired = await this.store.countFiredSince(
      t,
      orgId,
      task.accountId,
      new Date(Date.now() - HOUR_MS),
    );
    if (fired >= settings.maxRunsPerHour) return skip("rate_limited");
    if (deviceOffline) return skip("device_offline");
    if (queuePausedOn !== undefined) return skip("queue_paused");
    const claimed = await this.store.updateRun(t, run.id, {
      firedAt: new Date(),
      ...(plan.mode === "conversation" && { conversationId: plan.conversationId }),
    });
    // a start that fails for good leaves the run claimed: its settle check releases or ends it
    await oweAutomationSettle(this.outbox, run.id, orgId, 0, AUTOMATION_SETTLE_AFTER_MS);
    return { plan: { ...plan, run: claimed ?? run } };
  }

  /** The marker a run's message carries: the event marker, or the schedule marker and zone. */
  private markerOf(plan: StartPlan): InternalMessageOptions {
    const { task, run } = plan;
    if (plan.event !== undefined) return { automationEvent: plan.event };
    const trigger = task.trigger;
    if (trigger.kind === "event" || run.scheduledFor === null) {
      throw new Error(`automation run ${run.id}: a time run without a tick`);
    }
    const marker: ScheduleMarker = {
      taskId: task.id,
      taskRunId: run.id,
      scheduledFor: run.scheduledFor.toISOString(),
      trial: run.trial,
      taskName: task.name,
      localTime: localTimeOf(run.scheduledFor, trigger.timeZone),
    };
    return { schedule: marker, timeZoneOverride: trigger.timeZone };
  }

  /** Step 2 (see the class). */
  private async start(plan: StartPlan): Promise<void> {
    const { task, run } = plan;
    const internal = this.markerOf(plan);
    try {
      if (plan.mode === "new") {
        // model and effort are a new-conversation or subject task's only (spec §4, collaboration
        // §4.5): a conversation or chat task runs with that conversation's selection, never
        // switching it for a person
        const pick = {
          ...(task.model !== null && { model: task.model }),
          ...(task.effort !== null && { effort: task.effort }),
        };
        const out = await this.conversations.createWithMessage(
          task.orgId,
          task.accountId,
          task.agentId,
          { text: task.prompt, clientMessageId: run.id, ...pick },
          task.deviceId === null ? {} : { deviceId: task.deviceId },
          { ...internal, source: "web" },
        );
        // a retried start found the conversation made before: `createWithMessage` already asked
        // for its run (and the first start's message owes the ensure-run backstop)
        await this.setConversation(run.id, out.conversation.id);
        return;
      }
      let conversationId: string;
      // a subject conversation with no message yet takes the task's model and effort with its
      // first message, as a new-conversation task's does; a later run switches nothing
      let pick: { model?: NonNullable<Automation["model"]>; effort?: string } = {};
      if (plan.mode === "chat" || plan.mode === "group") {
        const bound = plan.mode === "chat" ? await this.bindChat(plan) : await this.openGroup(plan);
        if (bound === null) return;
        conversationId = bound;
      } else if (plan.mode === "subject") {
        const bound = await this.bindSubject(plan);
        if (bound === null) return;
        conversationId = bound.conversationId;
        if (bound.fresh) {
          pick = {
            ...(task.model !== null && { model: task.model }),
            ...(task.effort !== null && { effort: task.effort }),
          };
        }
      } else {
        conversationId = plan.conversationId;
      }
      await this.queue.add(
        task.orgId,
        conversationId,
        task.accountId,
        { text: task.prompt, clientMessageId: automationClientMessageId(run.id), ...pick },
        internal,
      );
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const reason: TaskRunSkipReason | undefined =
        e.code === "agent.not_found"
          ? "agent_gone"
          : e.code === "conversation.not_found"
            ? plan.mode === "chat" || plan.mode === "group" || plan.mode === "subject"
              ? "target_gone"
              : "conversation_gone"
            : DEVICE_GONE.has(e.code)
              ? "device_offline"
              : undefined;
      if (reason !== undefined) {
        await this.unstart(run.id, task.id, reason);
        return;
      }
      this.log.warn("automation run could not start", {
        taskId: task.id,
        taskRunId: run.id,
        code: e.code,
      });
      await this.failStart(run.id, task.id, e.message);
    }
  }

  /**
   * The DM's live conversation, or a new one bound to it (`findOrBindThread`), in one transaction:
   * a conversation it creates is the task's (`conversations.automation_id`). Null when the
   * live conversation's queue is paused (the run is skipped, `queue_paused`).
   */
  @Transactional()
  private async bindChat(plan: Extract<StartPlan, { mode: "chat" }>): Promise<string | null> {
    const { task, run } = plan;
    const t = this.db;
    // the one lock order: task row, then the task run
    await lockTaskRow(t, task.id);
    const locked = await t
      .selectFrom("automation_runs")
      .select("status")
      .where("id", "=", run.id)
      .forUpdate()
      .executeTakeFirst();
    if (locked?.status !== "pending") return null;
    const { conversationId, created } = await findOrBindThread(
      t,
      plan.thread,
      plan.target,
      async () => {
        const conv = await this.conversations.create(
          task.orgId,
          task.accountId,
          task.agentId,
          // a chat task takes no device (new mode only): an IM conversation's default
          { im: true },
          { source: channelSource(plan.target.chatType) },
        );
        await t
          .updateTable("conversations")
          .set({ automation_id: task.id })
          .where("id", "=", conv.id)
          .where("org_id", "=", task.orgId)
          .execute();
        return conv.id;
      },
    );
    if (!created && (await this.queuePaused(conversationId))) {
      await this.skipIn(t, run.id, task.id, "queue_paused");
      return null;
    }
    await this.store.updateRun(t, run.id, { conversationId });
    return conversationId;
  }

  /**
   * A group run's conversation (spec §8): a new one per run, the task's
   * (`conversations.automation_id`), whose delivery goes to the group with its thread still to
   * bind (`channel_deliveries.pending_thread_account_id` = the creator): outbound binds it at the
   * run's first post, thread key = that message's id, so replies in that thread continue the
   * conversation. One transaction; a retried start reuses the conversation it made before.
   */
  @Transactional()
  private async openGroup(plan: Extract<StartPlan, { mode: "group" }>): Promise<string | null> {
    const { task, run } = plan;
    const t = this.db;
    // the one lock order: task row, then the task run
    await lockTaskRow(t, task.id);
    const locked = await t
      .selectFrom("automation_runs")
      .select(["status", "conversation_id"])
      .where("id", "=", run.id)
      .forUpdate()
      .executeTakeFirst();
    if (locked?.status !== "pending") return null;
    if (locked.conversation_id !== null) return locked.conversation_id;
    const target: ChannelTarget = { chatId: plan.chatId, chatType: "group" };
    const conv = await this.conversations.create(
      task.orgId,
      task.accountId,
      task.agentId,
      // a chat task takes no device (new mode only): an IM conversation's default
      { im: true },
      // stored now: the thread to derive it from binds only at the run's first post
      { source: channelSource(target.chatType) },
    );
    await t
      .updateTable("conversations")
      .set({ automation_id: task.id })
      .where("id", "=", conv.id)
      .where("org_id", "=", task.orgId)
      .execute();
    await t
      .insertInto("channel_deliveries")
      .values({
        conversation_id: conv.id,
        connection_id: plan.connectionId,
        target: JSON.stringify(target),
        last_seq: 0,
        pending_thread_account_id: task.accountId,
      })
      .execute();
    await this.store.updateRun(t, run.id, { conversationId: conv.id });
    return conv.id;
  }

  /**
   * A subject run's conversation (collaboration spec §4.5), in one transaction under the task row
   * lock (so two runs of one subject never create two): the conversation `automation_conversations`
   * maps the subject to, when it is still live, the owner's chat with the task's agent and
   * accessible; else a new one, the task's (`conversations.automation_id`) with
   * `conversations.subject` set, whose mapping replaces the stale one (the mapping has no foreign
   * key: a deleted conversation leaves it behind). Null when the run is no longer pending or the
   * mapped conversation's queue is paused (the run is skipped, `queue_paused`). A retried start
   * reuses the conversation the run already recorded. `fresh`: the conversation has no message
   * yet, logged or queued by another run (just created, or created by a start that stopped
   * before its message), so this run's message carries the task's model and effort.
   */
  @Transactional()
  private async bindSubject(
    plan: Extract<StartPlan, { mode: "subject" }>,
  ): Promise<{ conversationId: string; fresh: boolean } | null> {
    const { task, run, subject } = plan;
    const t = this.db;
    // the one lock order: task row, then the task run
    await lockTaskRow(t, task.id);
    const locked = await t
      .selectFrom("automation_runs")
      .select(["status", "conversation_id"])
      .where("id", "=", run.id)
      .forUpdate()
      .executeTakeFirst();
    if (locked?.status !== "pending") return null;
    if (locked.conversation_id !== null) {
      const id = locked.conversation_id;
      return { conversationId: id, fresh: await this.noMessageYet(id, run.id) };
    }
    const mapped = await this.subjectConversation(task, subject);
    if (mapped !== undefined) {
      if (mapped.queuePaused) {
        await this.skipIn(t, run.id, task.id, "queue_paused");
        return null;
      }
      await this.store.updateRun(t, run.id, { conversationId: mapped.id });
      return { conversationId: mapped.id, fresh: await this.noMessageYet(mapped.id, run.id) };
    }
    const trigger = task.trigger;
    if (trigger.kind !== "event")
      throw new Error(`automation ${task.id}: subject mode without events`);
    const conv = await this.conversations.create(
      task.orgId,
      task.accountId,
      task.agentId,
      // a subject task takes no device (new mode only): the default pick for new conversations
      {},
      {
        source: "web",
        subject: {
          source: trigger.source,
          kind: subject.kind,
          id: subject.id,
          title: subject.title,
        },
      },
    );
    await t
      .updateTable("conversations")
      .set({ automation_id: task.id })
      .where("id", "=", conv.id)
      .where("org_id", "=", task.orgId)
      .execute();
    await t
      .insertInto("automation_conversations")
      .values({
        org_id: task.orgId,
        automation_id: task.id,
        subject_kind: subject.kind,
        subject_id: subject.id,
        conversation_id: conv.id,
      })
      .onConflict((oc) =>
        oc
          .columns(["automation_id", "subject_kind", "subject_id"])
          .doUpdateSet({ conversation_id: conv.id, created_at: sql`now()` }),
      )
      .execute();
    await this.store.updateRun(t, run.id, { conversationId: conv.id });
    return { conversationId: conv.id, fresh: true };
  }

  /**
   * Conversation `conversationId` has no event yet (`last_seq` 0) and no queued message other
   * than task run `runId`'s own (see {@link bindSubject}).
   */
  private async noMessageYet(conversationId: string, runId: string): Promise<boolean> {
    const conv = await this.db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (conv === undefined || Number(conv.last_seq) !== 0) return false;
    const queued = await this.db
      .selectFrom("conversation_queue")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("client_message_id", "!=", automationClientMessageId(runId))
      .limit(1)
      .executeTakeFirst();
    return queued === undefined;
  }

  /**
   * The live conversation `automation_conversations` maps a subject of the task to (see
   * {@link bindSubject}), or undefined: no mapping, or its conversation is gone, deleted, no
   * longer the owner's chat with the task's agent, or not accessible.
   */
  private async subjectConversation(
    task: Automation,
    subject: Pick<TriggerSubject, "kind" | "id">,
  ): Promise<{ id: string; queuePaused: boolean } | undefined> {
    const conv = await this.db
      .selectFrom("automation_conversations as m")
      .innerJoin("conversations as c", "c.id", "m.conversation_id")
      .select(["c.id", "c.queue_paused"])
      .where("m.org_id", "=", task.orgId)
      .where("m.automation_id", "=", task.id)
      .where("m.subject_kind", "=", subject.kind)
      .where("m.subject_id", "=", subject.id)
      .where("c.org_id", "=", task.orgId)
      .where("c.account_id", "=", task.accountId)
      .where("c.agent_id", "=", task.agentId)
      .where("c.kind", "=", "chat")
      .where("c.deleted_at", "is", null)
      .executeTakeFirst();
    if (!conv) return undefined;
    if (!(await this.access.isAccessible(task.orgId, conv.id, task.accountId))) return undefined;
    return { id: conv.id, queuePaused: conv.queue_paused };
  }

  /**
   * An event run's marker (collaboration spec §4.6): the events its deliveries name, in the order
   * they were stored (the coalescer's order), each with its type, subject and summary; past
   * {@link AUTOMATION_EVENT_HEAD} + {@link AUTOMATION_EVENT_TAIL} events only the first and the
   * latest, the rest counted (`omittedEvents`; every delivery stays bound to the run); undefined
   * when it has none.
   */
  private async eventMarkerOf(
    task: Automation,
    runId: string,
    source: string,
  ): Promise<AutomationEventMarker | undefined> {
    const rows = await this.db
      .selectFrom("automation_event_deliveries as d")
      .innerJoin("trigger_events as e", "e.id", "d.event_id")
      .select(["e.id", "e.type", "e.subject", "e.summary"])
      .where("d.org_id", "=", task.orgId)
      .where("d.automation_id", "=", task.id)
      .where("d.automation_run_id", "=", runId)
      .orderBy("e.created_at")
      .orderBy("e.id")
      .execute();
    if (rows.length === 0) return undefined;
    const cap = AUTOMATION_EVENT_HEAD + AUTOMATION_EVENT_TAIL;
    const omitted = Math.max(0, rows.length - cap);
    const shown =
      omitted === 0
        ? rows
        : [...rows.slice(0, AUTOMATION_EVENT_HEAD), ...rows.slice(-AUTOMATION_EVENT_TAIL)];
    return {
      automationId: task.id,
      automationRunId: runId,
      automationName: task.name,
      source,
      ...(omitted > 0 && { omittedEvents: omitted }),
      events: shown.map((r) => ({
        id: r.id,
        type: r.type,
        subject: {
          kind: r.subject.kind,
          id: r.subject.id,
          title: r.subject.title,
          ...(r.subject.url !== undefined && { url: r.subject.url }),
        },
        summary: r.summary,
      })),
    };
  }

  /** The start found the target gone: `fired_at` back to null, skipped with `reason`. */
  @Transactional()
  private async unstart(runId: string, taskId: string, reason: TaskRunSkipReason): Promise<void> {
    // the one lock order: task row (paused for a lasting reason), then the task run
    await lockTaskRow(this.db, taskId);
    await this.skipIn(this.db, runId, taskId, reason);
  }

  /**
   * The start was refused for another reason (a full queue, a model gone since the task was
   * saved, …): the run failed, and counts toward the task's failures as a failed run does.
   */
  @Transactional()
  private async failStart(runId: string, taskId: string, message: string): Promise<void> {
    // the one lock order: task row (its failure count, maybe paused), then the task run
    await lockTaskRow(this.db, taskId);
    await this.tracker.failStartIn(runId, message);
  }

  @Transactional()
  private async setConversation(runId: string, conversationId: string): Promise<void> {
    await this.db
      .updateTable("automation_runs")
      .set({ conversation_id: conversationId })
      .where("id", "=", runId)
      .where("conversation_id", "is", null)
      .execute();
  }

  /** Marks a pending run skipped (never fired) and pauses the task for a lasting reason. */
  private async skipIn(
    t: KernelSchemaDb,
    runId: string,
    taskId: string,
    reason: TaskRunSkipReason,
  ): Promise<void> {
    const r = await t
      .updateTable("automation_runs")
      .set({ status: "skipped", skip_reason: reason, fired_at: null })
      .where("id", "=", runId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) return;
    if (LASTING.has(reason)) await pauseTaskIn(t, taskId, reason as AutomationPauseReason, null);
    this.log.info("automation run skipped", { taskId, taskRunId: runId, reason });
  }

  /** Another run of the task is still in flight (stale ones are settled on the way). */
  private async overlaps(taskId: string, runId: string): Promise<boolean> {
    for (let i = 0; i < OVERLAP_SETTLE_MAX; i++) {
      const prev = await this.store.latestNonTerminalRun(this.db, taskId, runId);
      if (prev === null) return false;
      if (await this.tracker.inFlightIn(prev)) return true;
    }
    return true;
  }

  /** The creator is an active account and still a member of the org. */
  private async creatorActive(orgId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("memberships as m")
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .select("a.status")
      .where("m.org_id", "=", orgId)
      .where("m.account_id", "=", accountId)
      .executeTakeFirst();
    return row?.status === "active";
  }

  /** The target conversation, live, the creator's chat with the task's agent and accessible. */
  private async targetConversation(
    task: Automation,
  ): Promise<{ id: string; queuePaused: boolean } | undefined> {
    if (task.conversationId === null) return undefined;
    const conv = await this.db
      .selectFrom("conversations")
      .select(["id", "queue_paused"])
      .where("id", "=", task.conversationId)
      .where("org_id", "=", task.orgId)
      .where("account_id", "=", task.accountId)
      .where("agent_id", "=", task.agentId)
      .where("kind", "=", "chat")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!conv) return undefined;
    if (!(await this.access.isAccessible(task.orgId, conv.id, task.accountId))) return undefined;
    return { id: conv.id, queuePaused: conv.queue_paused };
  }

  private async queuePaused(conversationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("conversations")
      .select("queue_paused")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    return row?.queue_paused === true;
  }

  /**
   * The DM thread key of the creator in `chatId` (the key inbound uses, `dm:<externalId>`), from
   * their external ids on the connection's identity source (`<plugin>:<tenant>`): the id whose
   * thread row in this chat is the newest (archived rows count); when none has a row there, the
   * smallest id (deterministic). Without an identity (no tenant yet), the key of their newest DM
   * thread row in the chat. Undefined when neither exists.
   */
  private async dmThreadKey(
    conn: { id: string; plugin: string; tenantId: string | null },
    chatId: string,
    accountId: string,
  ): Promise<string | undefined> {
    const rows = await this.db
      .selectFrom("channel_threads")
      .select("thread_key")
      .where("connection_id", "=", conn.id)
      .where("chat_id", "=", chatId)
      .where("account_id", "=", accountId)
      .where("thread_key", "like", "dm:%")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const used = rows.map((r) => r.thread_key);
    if (conn.tenantId !== null) {
      const ids = await this.db
        .selectFrom("identities")
        .select("external_id")
        .where("source", "=", `${conn.plugin}:${conn.tenantId}`)
        .where("account_id", "=", accountId)
        .orderBy("external_id")
        .execute();
      const keys = ids.map((r) => `dm:${r.external_id}`);
      // several ids on the source: the one with the newest thread row in this chat
      const inChat = used.find((key) => keys.includes(key));
      if (inChat !== undefined) return inChat;
      if (keys[0] !== undefined) return keys[0];
    }
    return used[0];
  }

  /**
   * The creator has written in the group (spec §8: a group thread row of theirs exists there,
   * archived ones included), so a run may post there on their behalf.
   */
  private async inGroup(connectionId: string, chatId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("channel_threads")
      .select("id")
      .where("connection_id", "=", connectionId)
      .where("chat_id", "=", chatId)
      .where("account_id", "=", accountId)
      .where("thread_key", "not like", "dm:%")
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The device is gone, or its provider serves it over the dial-in channel and its machine is not
   * connected now ({@link DialInRelay.online}). A provider not loaded here is not asked: the run's
   * own sandbox use refuses it (`device.unavailable`).
   */
  private async deviceOffline(orgId: string, deviceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("devices")
      .select(["provider", "deleted_at"])
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) return true;
    const p = this.providers.forDevice(row.provider);
    if (p === undefined || !servesDialIn(p)) return false;
    return !(await this.relay.online(deviceId));
  }
}

/**
 * The fire job and the scanner, worker only: imported by `MaintenanceModule` (which dispatches
 * `automation-fire`) and `WorkerModule` (the scan's `@LockedCron`), never by another role.
 */
@Module({
  imports: [
    ConversationsModule,
    ChannelsModule,
    RuntimeModule,
    AgentLookupModule,
    ConversationAccessModule,
    OrgLockModule,
    AutomationStoreModule,
    AutomationTrackerModule,
    DialInRelayModule,
    SandboxProviderRegistryModule,
  ],
  providers: [AutomationFirer, AutomationScanJob],
  exports: [AutomationFirer],
})
export class AutomationFireModule {}
