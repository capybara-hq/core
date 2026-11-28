import {
  type EventFilter,
  InboxError,
  matchesFilter,
  type TriggerEventDeclaration,
  type TriggerSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { conversationAncestors } from "../../conversations/tree.js";
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
import { readAutomationSettings } from "../effective-settings.js";
import type { TriggerDispatchJobData } from "../job-ids.js";
import { AutomationStoreModule } from "../store.module.js";
import type { AutomationTrigger } from "../types.js";
import { AcceptanceModule, AcceptanceService } from "./acceptance.js";
import { EventCoalescer } from "./coalesce.js";
import { TriggerSourceTimeout, withDeadline } from "./deadline.js";
import { deliverEvent, type EventCause, type EventRow, filterAllowed } from "./deliver.js";
import { depthExceeded, isSelfTriggered } from "./guards.js";
import { TriggerEventSweepJob } from "./sweep.job.js";

export { TriggerSourceTimeout } from "./deadline.js";

/** One active event automation of the org that the event's source and type select. */
interface Candidate {
  id: string;
  accountId: string;
  agentId: string;
  filter: EventFilter;
}

/**
 * Routes one stored trigger event to the event automations it fires (collaboration spec §4.3,
 * §4.7), the `trigger-dispatch` job. In order:
 * - an event no longer `pending` was dispatched before (a retried job): nothing to do;
 * - past the org's `maxEventDepth` the event is `depth_stopped`, and the owner of the chain's last
 *   automation (the one whose run caused the event) gets a kernel inbox item
 *   `automation_depth_stopped` linking to it, one open item per automation;
 * - a source the org switched off (`eventSourcesOff`), or one that does not serve the org now (its
 *   extension disabled, unloaded, its config invalid) or no longer declares the type, leaves the
 *   event `undelivered`: no run, no retry. A provider whose status could not be read (a transient
 *   error) fails the job, so BullMQ retries it;
 * - a directed event (`audience` set) is routed by its audience's acceptance rule
 *   ({@link AcceptanceService.route}): it reaches at most that person's acceptance automation for
 *   the source and agent, or becomes a work offer, or nothing;
 * - the active, unexpired event automations people made in the org on this source and type whose
 *   filter matches the facts, minus the ones the event's cause run made (the same owner and the
 *   agent of the run's root conversation: self-trigger), are checked with the source's `visible()`
 *   once for all their owners; an owner it does not admit gets nothing;
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
    @Inject(AcceptanceService) private readonly acceptance: Pick<AcceptanceService, "route">,
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
    if (ev.audience !== null) {
      await this.acceptance.route(ev, {
        decl,
        declared,
        cause,
        settings,
        visible: async (accountIds) =>
          ask("visible()", () =>
            source.impl.visible({
              orgId,
              accountIds,
              subject: ev.subject,
              config: source.config,
            }),
          ),
      });
      return;
    }
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
      cause: EventCause;
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
    await deliverEvent({ db, outbox: this.outbox, log: this.log }, ev, automationIds, {
      decl,
      cause,
      coalesceSeconds,
    });
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
   * The active, unexpired event automations people made in the org on `plugin` whose types include
   * `type` (one past its `expires_at` gets nothing; the scan ends it). Acceptance automations take
   * only directed events, through the acceptance routing.
   */
  private async candidates(orgId: string, plugin: string, type: string): Promise<Candidate[]> {
    const rows = await this.kdb.db
      .selectFrom("automations")
      .select(["id", "account_id", "agent_id", "trigger"])
      .where("org_id", "=", orgId)
      .where("status", "=", "active")
      .where("origin", "=", "person")
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
  private async causeOf(orgId: string, runId: string | null): Promise<EventCause> {
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
  imports: [ExtensionsModule, AutomationStoreModule, InboxItemsModule, AcceptanceModule],
  providers: [TriggerDispatcher, EventCoalescer, TriggerEventSweepJob],
  exports: [TriggerDispatcher, EventCoalescer],
})
export class TriggerDispatchModule {}
