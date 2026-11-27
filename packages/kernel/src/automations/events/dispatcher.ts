import {
  type EventFilter,
  matchesFilter,
  type TriggerEventDeclaration,
  type TriggerSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import type { TriggerEventsTable } from "../../db/kernel-schema.js";
import { ExtensionsModule } from "../../extensions/extensions.module.js";
import { ExtensionPointDefaults } from "../../extensions/point-defaults.js";
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
import { coalesceJobId, depthExceeded, isSelfTriggered, subjectKey } from "./guards.js";

type EventRow = Selectable<TriggerEventsTable>;

/** One active event automation of the org that the event's source and type select. */
interface Candidate {
  id: string;
  accountId: string;
  agentId: string;
  filter: EventFilter;
}

/**
 * A window whose first delivery waits this long past its coalescing window is taken as lost (its
 * job failed for good): the next event of the pair opens a new window with a job of its own.
 */
export const COALESCE_STALE_MS = 10 * 60_000;

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
 * - past the org's `maxEventDepth` the event is `depth_stopped`;
 * - a source the org switched off (`eventSourcesOff`), or one that does not serve the org now (its
 *   extension disabled, unloaded, its config invalid) or no longer declares the type, leaves the
 *   event `undelivered`: no run, no retry. A provider whose status could not be read (a transient
 *   error) fails the job, so BullMQ retries it;
 * - the active event automations of the org on this source and type whose filter matches the
 *   facts, minus the ones the event's cause run made (the same owner and agent: self-trigger), are
 *   checked with the source's `visible()` once for all their owners; an owner it does not admit
 *   gets nothing;
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
  ) {}

  /** Dispatches event `eventId` of org `orgId` (see the class). */
  async dispatch(data: TriggerDispatchJobData): Promise<void> {
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
      // TODO(collaboration C1): the inbox notice to the owners of the chain's last automation
      this.log.warn("trigger event past the org's chain depth; not dispatched", {
        ...ctx,
        depth: ev.depth,
        maxEventDepth: settings.maxEventDepth,
      });
      await this.setState(orgId, eventId, "depth_stopped");
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
    const decl = source.impl.events().find((d) => d.type === ev.type);
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
      const seen = await source.impl.visible({
        orgId,
        accountIds: owners,
        subject: ev.subject,
        config: source.config,
      });
      admitted = new Set(seen.filter((a) => owners.includes(a)));
    }
    await this.record(
      ev,
      matching.filter((a) => admitted.has(a.accountId)).map((a) => a.id),
      settings.coalesceSeconds,
    );
  }

  /**
   * Delivers `ev` to `automationIds` and owes each opened window's coalesce job (see the class),
   * then marks the event `dispatched`; nothing when another dispatch of it got there first.
   */
  @Transactional()
  private async record(
    ev: EventRow,
    automationIds: readonly string[],
    coalesceSeconds: number,
  ): Promise<void> {
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
      // the automation row first, as the flush takes it: switched off or deleted since, skipped
      const live = await db
        .selectFrom("automations")
        .select("id")
        .where("org_id", "=", orgId)
        .where("id", "=", automationId)
        .where("status", "=", "active")
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (live === undefined) continue;
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

  /** The active event automations of the org on `plugin` whose types include `type`. */
  private async candidates(orgId: string, plugin: string, type: string): Promise<Candidate[]> {
    const rows = await this.kdb.db
      .selectFrom("automations")
      .select(["id", "account_id", "agent_id", "trigger"])
      .where("org_id", "=", orgId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
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

  /** The owner and agent of the run that caused the event (self-trigger), or null. */
  private async causeOf(
    orgId: string,
    runId: string | null,
  ): Promise<{ runAccountId: string; runAgentId: string } | null> {
    if (runId === null) return null;
    const run = await this.kdb.db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.trigger_account_id", "conversations.agent_id"])
      .where("runs.id", "=", runId)
      .where("conversations.org_id", "=", orgId)
      .executeTakeFirst();
    if (run?.trigger_account_id == null || run.agent_id == null) return null;
    return { runAccountId: run.trigger_account_id, runAgentId: run.agent_id };
  }

  private async setState(
    orgId: string,
    eventId: string,
    state: "dispatched" | "undelivered" | "depth_stopped",
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

/** The trigger event dispatcher and the coalescer, for the maintenance processor (worker only). */
@Module({
  imports: [ExtensionsModule, AutomationStoreModule],
  providers: [TriggerDispatcher, EventCoalescer],
  exports: [TriggerDispatcher, EventCoalescer],
})
export class TriggerDispatchModule {}
