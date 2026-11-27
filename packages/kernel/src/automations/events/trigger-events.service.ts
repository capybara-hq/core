import { randomUUID } from "node:crypto";
import {
  TriggerError,
  type TriggerEvent,
  type TriggerFactValue,
  type TriggerSubject,
  validateTriggerEvent,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { isExtensionEnabled } from "../../extensions/enabled.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../../runtime/maintenance-queue.js";
import { callScopeOf } from "../../tools/call-scope.js";
import {
  TRIGGER_DISPATCH_JOB,
  type TriggerDispatchJobData,
  triggerDispatchJobId,
} from "../job-ids.js";

/** Most facts one event may carry. */
export const TRIGGER_MAX_FACTS = 64;

/** Most UTF-8 bytes of one string fact value (also of each item of a `string[]` fact). */
export const TRIGGER_FACT_STRING_MAX_BYTES = 256;

/** Most UTF-8 bytes of `subject.kind`, `subject.id`, `dedupeKey` and each fact name. */
export const TRIGGER_KEY_MAX_BYTES = 256;

/** Most UTF-8 bytes of `subject.title`. */
export const TRIGGER_TITLE_MAX_BYTES = 1024;

/** Most UTF-8 bytes of `subject.url`. */
export const TRIGGER_URL_MAX_BYTES = 2048;

/** Most items of one `string[]` fact. */
export const TRIGGER_FACT_LIST_MAX_ITEMS = 64;

/** Who caused an event, as the kernel verified it. */
interface VerifiedCause {
  runId: string | null;
  accountId: string | null;
  depth: number;
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

const invalid = (message: string): TriggerError => new TriggerError("invalid_event", message);

/**
 * What the SDK's `validateTriggerEvent` leaves to the kernel boundary: lengths in UTF-8 bytes
 * (`subject.kind`, `subject.id`, `dedupeKey` and fact names {@link TRIGGER_KEY_MAX_BYTES},
 * `subject.title` {@link TRIGGER_TITLE_MAX_BYTES}, `subject.url` {@link TRIGGER_URL_MAX_BYTES});
 * `facts` is a flat object
 * of at most {@link TRIGGER_MAX_FACTS} values, each a string (at most
 * {@link TRIGGER_FACT_STRING_MAX_BYTES} bytes), a finite number, a boolean or a list of such
 * strings (at most {@link TRIGGER_FACT_LIST_MAX_ITEMS}); `subject.url` is a string when given;
 * `audience` names an account and an agent; `cause` is one of its two shapes.
 */
function checkShape(e: TriggerEvent): void {
  const capped: [string, string, number][] = [
    ["subject.kind", e.subject.kind, TRIGGER_KEY_MAX_BYTES],
    ["subject.id", e.subject.id, TRIGGER_KEY_MAX_BYTES],
    ["subject.title", e.subject.title, TRIGGER_TITLE_MAX_BYTES],
    ["dedupeKey", e.dedupeKey, TRIGGER_KEY_MAX_BYTES],
  ];
  for (const [field, value, max] of capped)
    if (bytes(value) > max) throw invalid(`${field} is at most ${max} bytes`);
  if (!isPlainObject(e.facts)) throw invalid("facts must be an object of fact values");
  const facts = Object.entries(e.facts);
  if (facts.length > TRIGGER_MAX_FACTS)
    throw invalid(`facts holds at most ${TRIGGER_MAX_FACTS} values`);
  const okString = (s: unknown): boolean =>
    typeof s === "string" && bytes(s) <= TRIGGER_FACT_STRING_MAX_BYTES;
  for (const [name, v] of facts) {
    if (bytes(name) > TRIGGER_KEY_MAX_BYTES)
      throw invalid(`fact names are at most ${TRIGGER_KEY_MAX_BYTES} bytes`);
    const ok =
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      okString(v) ||
      (Array.isArray(v) && v.length <= TRIGGER_FACT_LIST_MAX_ITEMS && v.every(okString));
    if (!ok)
      throw invalid(
        `fact "${name}" must be a string of at most ${TRIGGER_FACT_STRING_MAX_BYTES} bytes, a finite number, a boolean or a list of at most ${TRIGGER_FACT_LIST_MAX_ITEMS} such strings`,
      );
  }
  if (e.subject.url !== undefined && typeof e.subject.url !== "string")
    throw invalid("subject.url must be a string");
  if (e.subject.url !== undefined && bytes(e.subject.url) > TRIGGER_URL_MAX_BYTES)
    throw invalid(`subject.url is at most ${TRIGGER_URL_MAX_BYTES} bytes`);
  if (e.audience !== undefined) {
    if (
      !isPlainObject(e.audience) ||
      !nonEmpty(e.audience.accountId) ||
      !nonEmpty(e.audience.agentId)
    )
      throw invalid("audience must name a non-empty accountId and agentId");
  }
  if (e.cause !== undefined) {
    const c = e.cause as unknown;
    const call = isPlainObject(c) && "call" in c;
    const account = isPlainObject(c) && "accountId" in c;
    if (call === account)
      throw invalid("cause must be { call } (a tool call context) or { accountId }");
  }
}

/**
 * Stores the events extensions emit (`ctx.triggers.emit`, collaboration spec §4.2) and owes their
 * dispatch. The emitting extension, the event types it may emit (its approved manifest's
 * `permissions.triggers.emit`) and the cause's run and depth are the kernel's: an extension cannot
 * name another plugin, an undeclared type, a run of another org or a chain depth of its choosing.
 */
@Injectable()
export class TriggerEventsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
  ) {}

  /**
   * Validates `e` for `plugin` (whose approved manifest declares `declared`), checks the plugin is
   * enabled in the event's org and verifies the cause: a tool call context must be one the tool
   * pipeline made (its run read from the call scope, never from the context's own fields) for a
   * run of the event's org, and the event's depth is that run's trigger event's depth + 1 (0 when
   * the run started from no event); an account must be an active member of the org (depth 0).
   * Then inserts the `trigger_events` row and owes its `trigger-dispatch` job in the same
   * transaction. An event already stored for (org, plugin, dedupe key) is a duplicate: its id comes
   * back with `duplicate: true` and nothing is owed. The caller runs it in the event's org scope.
   *
   * Throws `TriggerError`: `type_not_declared`, `invalid_event` (a missing or malformed field, a
   * forged or foreign cause), `org_disabled` (the plugin is not enabled in the org).
   */
  @Transactional()
  async emit(
    plugin: string,
    declared: readonly string[],
    e: TriggerEvent,
  ): Promise<{ eventId: string; duplicate: boolean }> {
    if (!isPlainObject(e)) throw invalid("the event must be an object");
    const errs = validateTriggerEvent(e, declared);
    if (errs.includes("type_not_declared"))
      throw new TriggerError(
        "type_not_declared",
        `event type "${e.type}" is not declared in permissions.triggers.emit of ${plugin}`,
      );
    if (errs.length > 0) throw invalid(`invalid event: ${errs.join(", ")}`);
    checkShape(e);
    const db = this.kdb.db;
    if (!(await isExtensionEnabled(db, e.orgId, plugin)))
      throw new TriggerError("org_disabled", `${plugin} is not enabled in org ${e.orgId}`);
    const cause = await this.verifyCause(e);
    const subject: TriggerSubject = {
      kind: e.subject.kind,
      id: e.subject.id,
      title: e.subject.title,
      ...(e.subject.url !== undefined && { url: e.subject.url }),
    };
    const facts: Record<string, TriggerFactValue> = Object.fromEntries(
      Object.entries(e.facts).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
    );
    const id = randomUUID();
    const inserted = await db
      .insertInto("trigger_events")
      .values({
        id,
        org_id: e.orgId,
        plugin,
        type: e.type,
        subject: JSON.stringify(subject),
        facts: JSON.stringify(facts),
        summary: e.summary,
        dedupe_key: e.dedupeKey,
        audience:
          e.audience === undefined
            ? null
            : JSON.stringify({ accountId: e.audience.accountId, agentId: e.audience.agentId }),
        cause_account_id: cause.accountId,
        cause_run_id: cause.runId,
        depth: cause.depth,
      })
      .onConflict((oc) => oc.columns(["org_id", "plugin", "dedupe_key"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted === undefined) {
      const existing = await db
        .selectFrom("trigger_events")
        .select("id")
        .where("org_id", "=", e.orgId)
        .where("plugin", "=", plugin)
        .where("dedupe_key", "=", e.dedupeKey)
        .executeTakeFirstOrThrow();
      return { eventId: existing.id, duplicate: true };
    }
    await this.outbox.add<TriggerDispatchJobData>({
      queue: MAINTENANCE_QUEUE_NAME,
      name: TRIGGER_DISPATCH_JOB,
      jobId: triggerDispatchJobId(id),
      data: { orgId: e.orgId, eventId: id },
      orgId: e.orgId,
    });
    return { eventId: id, duplicate: false };
  }

  /** The verified cause of `e` (see {@link emit}); no cause is depth 0 with nobody behind it. */
  private async verifyCause(e: TriggerEvent): Promise<VerifiedCause> {
    const cause = e.cause;
    if (cause === undefined) return { runId: null, accountId: null, depth: 0 };
    const db = this.kdb.db;
    if ("call" in cause) {
      // only the pipeline attaches run facts: a context built by the extension has none
      const facts = isPlainObject(cause.call) ? callScopeOf(cause.call)?.facts : undefined;
      if (facts === undefined)
        throw invalid("cause.call must be the tool call context the kernel passed to the handler");
      const run = await db
        .selectFrom("runs")
        .innerJoin("conversations", "conversations.id", "runs.conversation_id")
        .select(["runs.id", "runs.trigger_account_id", "runs.trigger_event_id"])
        .where("runs.id", "=", facts.runId)
        .where("conversations.org_id", "=", e.orgId)
        .executeTakeFirst();
      if (run === undefined) throw invalid("cause.call is a run of another org");
      let depth = 0;
      if (run.trigger_event_id !== null) {
        const from = await db
          .selectFrom("trigger_events")
          .select("depth")
          .where("id", "=", run.trigger_event_id)
          .where("org_id", "=", e.orgId)
          .executeTakeFirst();
        // the column has no foreign key: an event no longer stored (nothing deletes one today but
        // its org's deletion, which takes the run too) cannot extend a chain, which restarts at 0
        depth = from === undefined ? 0 : from.depth + 1;
      }
      return { runId: run.id, accountId: run.trigger_account_id, depth };
    }
    if (!nonEmpty(cause.accountId)) throw invalid("cause.accountId must be an account id");
    const member = await db
      .selectFrom("memberships")
      .innerJoin("orgs", "orgs.id", "memberships.org_id")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("memberships.account_id")
      .where("memberships.org_id", "=", e.orgId)
      .where("memberships.account_id", "=", cause.accountId)
      .where("orgs.deleted_at", "is", null)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    if (member === undefined)
      throw invalid("cause.accountId is not an active member of the event's org");
    return { runId: null, accountId: cause.accountId, depth: 0 };
  }
}
