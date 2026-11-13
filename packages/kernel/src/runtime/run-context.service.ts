import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import { EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { latestWebLocale } from "../conversations/message-context.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { isTimeZone } from "../time-zone.js";
import {
  currentRunContext,
  dateIn,
  type RunContext,
  runContextChange,
  sanitizeSenderName,
  snapshotDescription,
} from "./context/run-context.js";
import { runEndedIn } from "./run-status.js";

/**
 * Optional provider: the clock run start reads the date from and the `CurrentTime` builtin reads
 * the time from (default `Date.now`; tests).
 */
export const RUN_CONTEXT_CLOCK = Symbol("RUN_CONTEXT_CLOCK");

/** The idem key of a run's `run_context` (one per run at most). */
export const runContextIdemKey = (runId: string): string => `run_context:${runId}`;

/** What a run start tells {@link RunContextService.record}. */
export interface RunContextInput {
  orgId: string;
  conversationId: string;
  runId: string;
  /** The run's boundary: its trigger message (or the finish / delivery that woke it). */
  triggerSeq: number;
  /** The run's effective definition (a root run's agent version; a sub-agent's frozen one). */
  agent: AgentDefinition;
  /** A sub-agent run: the parent call that dispatched it and the child's roster name. */
  subagent?: {
    parentConversationId: string;
    parentRunId: string;
    /** The roster name (`subagent_started.agentType`), or the forked skill's name. */
    name: string;
  };
}

const cut = (s: string, max: number) => [...s].slice(0, max).join("");

/**
 * Run start's run context (spec 2026-11-08-run-context-design §5): compares the facts the run
 * would show the model (its agent's name and description, the org's name, today's date, the time
 * zone and language of the person whose message started it; for a sub-agent who dispatched it)
 * with the fold of the conversation's `run_context` events, and appends only what differs (the
 * first time: everything). Lazy: a rename writes nothing anywhere; the next run notices.
 */
@Injectable()
export class RunContextService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "appendIn" | "notify">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Optional() @Inject(RUN_CONTEXT_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  private clock(): Date {
    return new Date(this.now());
  }

  /**
   * Records the run's context (see the class) and notifies after the commit. False: the run had
   * ended (a stop got there first), so nothing was appended and the run must not go on.
   */
  async record(input: RunContextInput): Promise<boolean> {
    const seq = await this.append(input);
    if (seq === "ended") return false;
    if (seq !== null) await this.eventLog.notify(input.conversationId, seq);
    return true;
  }

  /**
   * One transaction under the conversation row lock (as `lockLatestCatalog`): fold, read the
   * current values, append when something differs, with the idem key `run_context:<runId>` (a
   * retried run start finds its event, or finds nothing changed). Returns the seq written;
   * `ended` when the run is terminal under the locks (nothing is appended after its end).
   */
  @Transactional()
  private async append(input: RunContextInput): Promise<number | null | "ended"> {
    const t = this.db.db;
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", input.conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (await runEndedIn(t, input.runId)) return "ended";
    const prev = await foldOf(t, input.conversationId);
    const next =
      input.subagent === undefined
        ? await this.rootContext(t, input)
        : await this.childContext(t, input, input.subagent);
    const change = runContextChange(prev, next);
    if (change === null) return null;
    const written = await this.eventLog.appendIn(input.conversationId, [
      {
        type: "run_context",
        runId: input.runId,
        idemKey: runContextIdemKey(input.runId),
        payload: change,
      },
    ]);
    return Math.max(...written.map((e) => e.seq));
  }

  /** A root run: agent, org, and the date, zone and language of the run's person (§3.4). */
  private async rootContext(t: KernelSchemaDb, input: RunContextInput): Promise<RunContext> {
    const org = await t
      .selectFrom("orgs")
      .select("name")
      .where("id", "=", input.orgId)
      .executeTakeFirst();
    const settings = await readOrgSettings(t, input.orgId);
    // the person whose message started the run: the latest message at or before the trigger (a
    // wake run has no message of its own). New messages record the zone and language used at send
    // time (IM-provided, account, browser, web language, org: message-context.ts); a message
    // without them (older logs) falls back to the author's own settings, then the org's (§3.4).
    const person = await t
      .selectFrom("conversation_events")
      .select([
        sql<string | null>`payload->>'timeZone'`.as("timeZone"),
        sql<string | null>`payload->>'locale'`.as("locale"),
        sql<string | null>`payload->>'authorAccountId'`.as("author"),
      ])
      .where("conversation_id", "=", input.conversationId)
      .where("type", "=", "user_message")
      .where("seq", "<=", String(input.triggerSeq))
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    const author = person?.author ?? null;
    let zone: string | undefined =
      person?.timeZone != null && isTimeZone(person.timeZone) ? person.timeZone : undefined;
    if (zone === undefined && author !== null) {
      const own = await t
        .selectFrom("accounts")
        .select("time_zone")
        .where("id", "=", author)
        .executeTakeFirst();
      if (own?.time_zone != null && isTimeZone(own.time_zone)) zone = own.time_zone;
    }
    zone ??= settings.timeZone ?? "UTC";
    let locale: "zh" | "en" | undefined =
      person?.locale === "zh" || person?.locale === "en" ? person.locale : undefined;
    if (locale === undefined && author !== null) {
      locale = await latestWebLocale(t, input.orgId, author);
    }
    locale ??= settings.locale;
    const description = snapshotDescription(input.agent.description);
    return {
      agent: { name: input.agent.name, ...(description !== undefined && { description }) },
      ...(org !== undefined && org.name.trim() !== "" && { org: { name: cut(org.name, 200) } }),
      date: dateIn(this.clock(), zone),
      timeZone: zone,
      locale,
    };
  }

  /**
   * A sub-agent run (spec §6): its roster name, who dispatched it (the parent agent's name and
   * the person the parent works for), and the parent's date and zone; no org, no language.
   */
  private async childContext(
    t: KernelSchemaDb,
    input: RunContextInput,
    child: NonNullable<RunContextInput["subagent"]>,
  ): Promise<RunContext> {
    const parent = await foldOf(t, child.parentConversationId);
    const parentAgent =
      parent.agent?.name ?? (await parentDefinitionName(t, child.parentRunId)) ?? "agent";
    const person =
      parent.dispatchedBy?.person ??
      (await latestSenderName(t, child.parentConversationId)) ??
      (await triggerName(t, child.parentRunId)) ??
      "a person";
    const zone = parent.timeZone ?? (await readOrgSettings(t, input.orgId)).timeZone ?? "UTC";
    return {
      agent: { name: cut(child.name, 130) },
      dispatchedBy: { agent: cut(parentAgent, 130), person },
      date: dateIn(this.clock(), zone),
      timeZone: zone,
    };
  }
}

/**
 * The time zone a conversation's run context holds now (the latest `run_context` with a
 * `timeZone`, as the fold reads it), else the org default (§3.3), else UTC. The `CurrentTime`
 * builtin's default zone.
 */
export async function conversationTimeZone(
  t: KernelSchemaDb,
  orgId: string,
  conversationId: string,
): Promise<string> {
  const row = await t
    .selectFrom("conversation_events")
    .select(sql<string | null>`payload->>'timeZone'`.as("timeZone"))
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "run_context")
    .where(sql<boolean>`payload ? 'timeZone'`)
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row?.timeZone != null && isTimeZone(row.timeZone)) return row.timeZone;
  const zone = (await readOrgSettings(t, orgId)).timeZone;
  return zone !== undefined && isTimeZone(zone) ? zone : "UTC";
}

/** The fold of a conversation's `run_context` events (read inside the caller's transaction). */
async function foldOf(t: KernelSchemaDb, conversationId: string): Promise<RunContext> {
  const rows = await t
    .selectFrom("conversation_events")
    .select(["seq", "payload"])
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "run_context")
    .orderBy("seq", "asc")
    .execute();
  return currentRunContext(
    rows.map(
      (r) => ({ type: "run_context", seq: Number(r.seq), payload: r.payload }) as ConversationEvent,
    ),
  );
}

/** The name in the parent run's agent version (a parent logged before run contexts existed). */
async function parentDefinitionName(t: KernelSchemaDb, runId: string): Promise<string | undefined> {
  const row = await t
    .selectFrom("runs")
    .innerJoin("conversations", "conversations.id", "runs.conversation_id")
    .innerJoin("agent_versions as v", (j) =>
      j
        .onRef("v.agent_id", "=", "conversations.agent_id")
        .onRef("v.version", "=", "runs.agent_version"),
    )
    .select(sql<string | null>`v.definition->>'name'`.as("name"))
    .where("runs.id", "=", runId)
    .executeTakeFirst();
  return row?.name ?? undefined;
}

/** The latest sender name in a conversation's log (the person the conversation works for). */
async function latestSenderName(
  t: KernelSchemaDb,
  conversationId: string,
): Promise<string | undefined> {
  const row = await t
    .selectFrom("conversation_events")
    .select(sql<string | null>`payload->'sender'->>'name'`.as("name"))
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "user_message")
    .where(sql<boolean>`payload ? 'sender'`)
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  const name = row?.name == null ? "" : sanitizeSenderName(row.name);
  return name === "" ? undefined : name;
}

/** The display name of the account that triggered a run. */
async function triggerName(t: KernelSchemaDb, runId: string): Promise<string | undefined> {
  const row = await t
    .selectFrom("runs")
    .innerJoin("accounts", "accounts.id", "runs.trigger_account_id")
    .select("accounts.display_name")
    .where("runs.id", "=", runId)
    .executeTakeFirst();
  const name = row === undefined ? "" : sanitizeSenderName(row.display_name);
  return name === "" ? undefined : name;
}
