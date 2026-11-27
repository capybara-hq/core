import {
  type EventFilter,
  InboxError,
  matchesFilter,
  type TriggerEventDeclaration,
  type TriggerSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import { conversationAncestors } from "../../conversations/tree.js";
import type { TriggerEventsTable } from "../../db/kernel-schema.js";
import { ExtensionsModule } from "../../extensions/extensions.module.js";
import { ExtensionPointDefaults } from "../../extensions/point-defaults.js";
import { InboxItemsModule, InboxItemsService } from "../../inbox/inbox-items.service.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../../runtime/maintenance-queue.js";
import { readAutomationSettings } from "../effective-settings.js";
import {
  AUTOMATION_COALESCE_JOB,
  type AutomationCoalesceJobData,
  type TriggerDispatchJobData,
} from "../job-ids.js";
import { AutomationStoreModule } from "../store.module.js";
import type { AutomationTrigger } from "../types.js";
import { EventCoalescer } from "./coalesce.js";
import { TriggerSourceTimeout, withDeadline } from "./deadline.js";
import {
  COALESCE_STALE_MS,
  coalesceJobId,
  depthExceeded,
  isSelfTriggered,
  subjectKey,
} from "./guards.js";
import { TriggerEventSweepJob } from "./sweep.job.js";

export { TriggerSourceTimeout } from "./deadline.js";

type EventRow = Selectable<TriggerEventsTable>;

/** One active event automation of the org that the event's source and type select. */
interface Candidate {
  id: string;
  accountId: string;
  agentId: string;
  filter: EventFilter;
}

/** Whether the automation's trigger still selects the event (re-read under its row lock). */
function triggerSelects(
  trigger: AutomationTrigger,
  ev: EventRow,
  decl: TriggerEventDeclaration,
): trigger is Extract<AutomationTrigger, { kind: "event" }> {
  if (trigger.kind !== "event" || trigger.source !== ev.plugin) return false;
  if (!trigger.types.includes(ev.type)) return false;
  const filter = trigger.filter ?? [];
  return filterAllowed(filter, decl) && matchesFilter(filter, ev.facts);
}

/**
 * A filter on a fact the source does not declare filterable never matches: an automation cannot
 * filter on a fact its source keeps out of filters (collaboration spec §4.3).
 */
function filterAllowed(filter: EventFilter, decl: TriggerEventDeclaration): boolean {
  return filter.every((c) => {
    const fact = Object.hasOwn(decl.facts, c.fact) ? decl.facts[c.fact] : undefined;
    return fact?.filterable === true;
  });
}

/**
 * Routes one stored trigger event to the event automations it fires (collaboration spec §4.3,
 * §4.7), the `trigger-dispatch` job. In order:
 * - an event no longer `pending` was dispatched before (a retried job): nothing to do;
 * - a directed event (`audience` set) is left `pending` for acceptance routing (PR C);
 * - past the org's `maxEventDepth` the event is `depth_stopped`, and the owner of the chain's last
 *   automation (the one whose run caused the event) gets a kernel inbox item
 *   `automation_depth_stopped` linking to it, one open item per automation;
 * - a source the org switched off (`eventSourcesOff`), or one that does not serve the org now (its
 *   extension disabled, unloaded, its config invalid) or no longer declares the type, leaves the
 *   event `undelivered`: no run, no retry. A provider whose status could not be read (a transient
 *   error) fails the job, so BullMQ retries it;
 * - the active, unexpired event automations of the org on this source and type whose filter
 *   matches the facts, minus the ones the event's cause run made (the same owner and the agent of
 *   the run's root conversation: self-trigger), are checked with the source's `visible()` once for
 *   all their owners; an owner it does not admit gets nothing;
 * - each remaining automation gets a delivery, and the delivery that opens a window for its
 *   (automation, subject) pair owes the pair's `automation-coalesce` job, due `coalesceSeconds`
 *   on; later events of the window find its deliveries waiting and owe nothing, so the window ends
 *   in one run ({@link EventCoalescer}). The event becomes `dispatched`.
 *
 * The provider is asked outside any transaction; the deliveries, the owed jobs and the state are
 * written in one, each automation row locked (id order), so a flush and a dispatch of one pair never
 * interleave.
 */
@Injectable()
export class TriggerDispatcher {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ExtensionPointDefaults)
    private readonly points: Pick<ExtensionPointDefaults, "providersFor">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
    @Inject(InboxItemsService) private readonly inbox: Pick<InboxItemsService, "post">,
  ) {}

  /**
   * Dispatches event `eventId` of org `orgId` (see the class). The source's `events()` and
   * `visible()` each have `tools.timeoutMs`: past it the job fails with
   * {@link TriggerSourceTimeout} (BullMQ retries it), and on its last attempt (`finalAttempt`) the
   * event is `undelivered` instead.
   */
  async dispatch(
    data: TriggerDispatchJobData,
    opts: { finalAttempt?: boolean } = {},
  ): Promise<void> {
    const { orgId, eventId } = data;
    const db = this.kdb.db;
    const ev = await db
      .selectFrom("trigger_events")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", eventId)
      .executeTakeFirst();
    if (ev === undefined || ev.state !== "pending") return;
    const ctx = { orgId, eventId, plugin: ev.plugin, type: ev.type };
    if (ev.audience !== null) {
      // TODO(collaboration C2): directed events are routed by the acceptance rules
      this.log.info("directed trigger event left pending for acceptance routing", ctx);
      return;
    }
    const settings = await readAutomationSettings(db, this.config, orgId);
    if (depthExceeded(ev.depth, settings.maxEventDepth)) {
      this.log.warn("trigger event past the org's chain depth; not dispatched", {
        ...ctx,
        depth: ev.depth,
        maxEventDepth: settings.maxEventDepth,
      });
      await this.stopForDepth(ev);
      return;
    }
    if (settings.eventSourcesOff.includes(ev.plugin)) {
      this.log.info("trigger event of a source the org switched off; not dispatched", ctx);
      await this.setState(orgId, eventId, "undelivered");
      return;
    }
    const { providers, failed } = await this.points.providersFor<TriggerSource>(
      orgId,
      "trigger-source",
    );
    const source = providers.find((p) => p.extension === ev.plugin);
    if (source === undefined) {
      if (failed.has(ev.plugin)) {
        // a transient read error: neither serving nor known to be off; the job retries
        throw new Error(`trigger source ${ev.plugin} status could not be read for org ${orgId}`);
      }
      this.log.info("trigger event of a source that does not serve the org; undelivered", ctx);
      await this.setState(orgId, eventId, "undelivered");
      return;
    }
    const ms = this.config.get().tools.timeoutMs;
    const ask = async <T>(what: string, call: () => T | Promise<T>): Promise<T | undefined> => {
      try {
        return await withDeadline(ev.plugin, what, ms, call);
      } catch (err) {
        if (!(err instanceof TriggerSourceTimeout) || opts.finalAttempt !== true) throw err;
        this.log.warn("trigger source did not answer on the dispatch's last attempt; undelivered", {
          ...ctx,
          err,
        });
        await this.setState(orgId, eventId, "undelivered");
        return undefined;
      }
    };
    const declared = await ask("events()", () => source.impl.events());
    if (declared === undefined) return;
    const decl = declared.find((d) => d.type === ev.type);
    if (decl === undefined) {
      this.log.info("trigger event of a type its source no longer declares; undelivered", ctx);
      await this.setState(orgId, eventId, "undelivered");
      return;
    }
    const cause = await this.causeOf(orgId, ev.cause_run_id);
    const matching = (await this.candidates(orgId, ev.plugin, ev.type)).filter(
      (a) =>
        filterAllowed(a.filter, decl) &&
        matchesFilter(a.filter, ev.facts) &&
        !isSelfTriggered(a, cause),
    );
    let admitted = new Set<string>();
    const owners = [...new Set(matching.map((a) => a.accountId))].sort();
    if (owners.length > 0) {
      const seen = await ask("visible()", () =>
        source.impl.visible({
          orgId,
          accountIds: owners,
          subject: ev.subject,
          config: source.config,
        }),
      );
      if (seen === undefined) return;
      admitted = new Set(seen.filter((a) => owners.includes(a)));
    }
    await this.record(
      ev,
      matching.filter((a) => admitted.has(a.accountId)).map((a) => a.id),
      { decl, cause, coalesceSeconds: settings.coalesceSeconds },
    );
  }

  /**
   * Delivers `ev` to `automationIds` and owes each opened window's coalesce job (see the class),
   * then marks the event `dispatched`; nothing when another dispatch of it got there first. Each
   * automation's trigger and agent are read again under its row lock: one edited since the match
   * (another type, source or filter; the cause run's agent now) gets no delivery.
   */
  @Transactional()
  private async record(
    ev: EventRow,
    automationIds: readonly string[],
    match: {
      decl: TriggerEventDeclaration;
      cause: { runAccountId: string; runAgentId: string } | null;
      coalesceSeconds: number;
    },
  ): Promise<void> {
    const { decl, cause, coalesceSeconds } = match;
    const db = this.kdb.db;
    const orgId = ev.org_id;
    const held = await db
      .selectFrom("trigger_events")
      .select("state")
      .where("org_id", "=", orgId)
      .where("id", "=", ev.id)
      .forUpdate()
      .executeTakeFirst();
    if (held?.state !== "pending") return;
    const key = subjectKey(ev.subject);
    const now = Date.now();
    for (const automationId of [...automationIds].sort()) {
      // the automation row first, as the flush takes it: switched off, expired or deleted since,
      // skipped
      const live = await db
        .selectFrom("automations")
        .select(["account_id", "agent_id", "trigger"])
        .where("org_id", "=", orgId)
        .where("id", "=", automationId)
        .where("status", "=", "active")
        .where("deleted_at", "is", null)
        .where((eb) =>
          eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]),
        )
        .forUpdate()
        .executeTakeFirst();
      if (live === undefined) continue;
      if (!triggerSelects(live.trigger as AutomationTrigger, ev, decl)) continue;
      if (isSelfTriggered({ accountId: live.account_id, agentId: live.agent_id }, cause)) continue;
      const waiting = await db
        .selectFrom("automation_event_deliveries")
        .select((eb) => eb.fn.min("created_at").as("first"))
        .where("org_id", "=", orgId)
        .where("automation_id", "=", automationId)
        .where("subject_key", "=", key)
        .where("automation_run_id", "is", null)
        .executeTakeFirst();
      const inserted = await db
        .insertInto("automation_event_deliveries")
        .values({ org_id: orgId, automation_id: automationId, event_id: ev.id, subject_key: key })
        .onConflict((oc) => oc.columns(["automation_id", "event_id"]).doNothing())
        .returning("event_id")
        .executeTakeFirst();
      if (inserted === undefined) continue;
      const first = waiting?.first ?? null;
      const open =
        first !== null &&
        now - new Date(first).getTime() < coalesceSeconds * 1000 + COALESCE_STALE_MS;
      if (open) continue;
      if (first !== null) {
        this.log.warn("coalescing window outlived its job; a new window takes its events", {
          orgId,
          automationId,
          subjectKey: key,
        });
      }
      await this.outbox.add<AutomationCoalesceJobData>({
        queue: MAINTENANCE_QUEUE_NAME,
        name: AUTOMATION_COALESCE_JOB,
        // one id per window: an add while an earlier window's job of the pair is still active
        // (flushing) or kept would otherwise be swallowed by BullMQ
        jobId: `${coalesceJobId(automationId, ev.subject)}-${ev.id}`,
        data: { orgId, automationId, subjectKey: key },
        runAt: new Date(now + coalesceSeconds * 1000),
        orgId,
      });
    }
    await this.setState(orgId, ev.id, "dispatched");
  }

  /**
   * Marks `ev` `depth_stopped` and tells the owner of the chain's last automation (the automation
   * whose run emitted the event) with a kernel inbox item, in one transaction; nothing when another
   * dispatch settled the event first. The item links to the automation and is posted once per
   * automation while open (`dedupeKey`); an owner no longer an active member gets none.
   */
  @Transactional()
  private async stopForDepth(ev: EventRow): Promise<void> {
    const db = this.kdb.db;
    const orgId = ev.org_id;
    const held = await db
      .updateTable("trigger_events")
      .set({ state: "depth_stopped" })
      .where("org_id", "=", orgId)
      .where("id", "=", ev.id)
      .where("state", "=", "pending")
      .returning("id")
      .executeTakeFirst();
    if (held === undefined || ev.cause_run_id === null) return;
    const last = await db
      .selectFrom("runs")
      .innerJoin("automation_runs", "automation_runs.id", "runs.automation_run_id")
      .innerJoin("automations", "automations.id", "automation_runs.automation_id")
      .select(["automations.id", "automations.account_id", "automations.name"])
      .where("runs.id", "=", ev.cause_run_id)
      .where("automation_runs.org_id", "=", orgId)
      .where("automations.org_id", "=", orgId)
      .where("automations.deleted_at", "is", null)
      .executeTakeFirst();
    if (last === undefined) return;
    try {
      await this.inbox.post(
        { kind: "kernel" },
        {
          orgId,
          accountId: last.account_id,
          kind: "automation_depth_stopped",
          title: last.name,
          body: `An event from ${ev.plugin} (${ev.type}) was not delivered: the chain of automations it came from reached the organization's depth limit.`,
          link: `/automations/${encodeURIComponent(last.id)}`,
          dedupeKey: `automation-depth-${last.id}`,
        },
      );
    } catch (err) {
      if (!(err instanceof InboxError)) throw err;
      this.log.info("chain depth notice not posted", { orgId, eventId: ev.id, err });
    }
  }

  /**
   * The active, unexpired event automations of the org on `plugin` whose types include `type` (one
   * past its `expires_at` gets nothing; the scan ends it).
   */
  private async candidates(orgId: string, plugin: string, type: string): Promise<Candidate[]> {
    const rows = await this.kdb.db
      .selectFrom("automations")
      .select(["id", "account_id", "agent_id", "trigger"])
      .where("org_id", "=", orgId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
      .where(sql<boolean>`trigger->>'kind' = 'event'`)
      .where(sql<boolean>`trigger->>'source' = ${plugin}`)
      .where(sql<boolean>`trigger->'types' @> ${JSON.stringify([type])}::jsonb`)
      .orderBy("id")
      .execute();
    return rows.flatMap((r) => {
      const t = r.trigger as AutomationTrigger;
      if (t.kind !== "event") return [];
      return [{ id: r.id, accountId: r.account_id, agentId: r.agent_id, filter: t.filter ?? [] }];
    });
  }

  /**
   * The owner and agent of the run that caused the event (self-trigger), or null. The agent is
   * the root conversation's: a sub-agent dispatched by an automation's run (its conversation a
   * child of the run's) acts for that run, so its events count as the automation's own.
   */
  private async causeOf(
    orgId: string,
    runId: string | null,
  ): Promise<{ runAccountId: string; runAgentId: string } | null> {
    if (runId === null) return null;
    const db = this.kdb.db;
    const run = await db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.trigger_account_id", "conversations.id as conversation_id"])
      .where("runs.id", "=", runId)
      .where("conversations.org_id", "=", orgId)
      .executeTakeFirst();
    if (run?.trigger_account_id == null) return null;
    // nearest first: the last ancestor is the root (none: the run's conversation is the root)
    const rootId =
      (await conversationAncestors(db, run.conversation_id)).at(-1) ?? run.conversation_id;
    const root = await db
      .selectFrom("conversations")
      .select("agent_id")
      .where("id", "=", rootId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (root?.agent_id == null) return null;
    return { runAccountId: run.trigger_account_id, runAgentId: root.agent_id };
  }

  private async setState(
    orgId: string,
    eventId: string,
    state: "dispatched" | "undelivered",
  ): Promise<void> {
    await this.kdb.db
      .updateTable("trigger_events")
      .set({ state })
      .where("org_id", "=", orgId)
      .where("id", "=", eventId)
      .where("state", "=", "pending")
      .execute();
  }
}

/**
 * The trigger event dispatcher and the coalescer, for the maintenance processor, and the trigger
 * event sweep (`@LockedCron`): worker only (imported by `MaintenanceModule` alone).
 */
@Module({
  imports: [ExtensionsModule, AutomationStoreModule, InboxItemsModule],
  providers: [TriggerDispatcher, EventCoalescer, TriggerEventSweepJob],
  exports: [TriggerDispatcher, EventCoalescer],
})
export class TriggerDispatchModule {}
