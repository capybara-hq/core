import { matchesFilter, type TriggerEventDeclaration } from "@capybara-hq/plugin-sdk";
import { type Selectable, sql } from "kysely";
import type { KernelSchemaDb, TriggerEventsTable } from "../../db/kernel-schema.js";
import type { OutboxService } from "../../infra/outbox/outbox.service.js";
import type { KernelLogger } from "../../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../../runtime/maintenance-queue.js";
import { AUTOMATION_COALESCE_JOB, type AutomationCoalesceJobData } from "../job-ids.js";
import type { AutomationTrigger } from "../types.js";
import { COALESCE_STALE_MS, coalesceJobId, isSelfTriggered, subjectKey } from "./guards.js";

export type EventRow = Selectable<TriggerEventsTable>;

/** The owner and agent of the run that caused an event (self-trigger), or null. */
export type EventCause = { runAccountId: string; runAgentId: string } | null;

/**
 * A filter on a fact the source does not declare filterable never matches: an automation cannot
 * filter on a fact its source keeps out of filters (collaboration spec §4.3).
 */
export function filterAllowed(
  filter: readonly { fact: string }[],
  decl: TriggerEventDeclaration,
): boolean {
  return filter.every((c) => {
    const fact = Object.hasOwn(decl.facts, c.fact) ? decl.facts[c.fact] : undefined;
    return fact?.filterable === true;
  });
}

/** Whether the automation's trigger still selects the event (re-read under its row lock). */
function triggerSelects(
  trigger: AutomationTrigger,
  ev: EventRow,
  decl: TriggerEventDeclaration,
): boolean {
  if (trigger.kind !== "event" || trigger.source !== ev.plugin) return false;
  if (!trigger.types.includes(ev.type)) return false;
  const filter = trigger.filter ?? [];
  return filterAllowed(filter, decl) && matchesFilter(filter, ev.facts);
}

/**
 * Delivers `ev` to each of `automationIds` that still takes it, and owes each opened window's
 * coalesce job (collaboration spec §4.7); the caller runs it in a transaction and decides the
 * event's state. Each automation row is locked (id order, as the flush takes it) and read again:
 * one switched off, expired or deleted since, whose trigger no longer selects the event, made by
 * the event's cause run (self-trigger), or of the wrong kind gets nothing. A directed event
 * (`audience` set) reaches only the acceptance automation of its audience (account and agent); an
 * undirected one only automations a person made. The delivery that opens a window for its
 * (automation, subject) pair owes the pair's `automation-coalesce` job, due `coalesceSeconds` on;
 * later events of the window find its deliveries waiting and owe nothing. Returns how many
 * deliveries it added.
 */
export async function deliverEvent(
  deps: {
    db: KernelSchemaDb;
    outbox: Pick<OutboxService, "add">;
    log: Pick<KernelLogger, "warn">;
  },
  ev: EventRow,
  automationIds: readonly string[],
  match: { decl: TriggerEventDeclaration; cause: EventCause; coalesceSeconds: number },
): Promise<number> {
  const { db, outbox, log } = deps;
  const { decl, cause, coalesceSeconds } = match;
  const orgId = ev.org_id;
  const key = subjectKey(ev.subject);
  const now = Date.now();
  let added = 0;
  for (const automationId of [...automationIds].sort()) {
    const live = await db
      .selectFrom("automations")
      .select(["account_id", "agent_id", "trigger", "origin"])
      .where("org_id", "=", orgId)
      .where("id", "=", automationId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
      .forUpdate()
      .executeTakeFirst();
    if (live === undefined) continue;
    const audience = ev.audience;
    if (audience === null) {
      if (live.origin !== "person") continue;
    } else if (
      live.origin !== "acceptance" ||
      live.account_id !== audience.accountId ||
      live.agent_id !== audience.agentId
    ) {
      continue;
    }
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
    added++;
    const first = waiting?.first ?? null;
    const open =
      first !== null &&
      now - new Date(first).getTime() < coalesceSeconds * 1000 + COALESCE_STALE_MS;
    if (open) continue;
    if (first !== null) {
      log.warn("coalescing window outlived its job; a new window takes its events", {
        orgId,
        automationId,
        subjectKey: key,
      });
    }
    await outbox.add<AutomationCoalesceJobData>({
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
  return added;
}
