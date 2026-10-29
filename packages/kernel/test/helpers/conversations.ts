// biome-ignore-all lint/suspicious/noExplicitAny: test pools carry no schema types
/**
 * The conversations providers over a test's own Kysely, for tests without a running kernel
 * (ruling R10; Task 5.1 moves the tests to the Nest application). Handles built for the same
 * Kysely object (or for its `legacyDbFor` view) share one `TransactionHost`, so the legacy code a
 * test drives and the event log it appends through share their transactions.
 */

import type { Kysely } from "kysely";
import type { AgentLookup } from "../../src/agents/agent-lookup.js";
import { AgentTemplatesService } from "../../src/agents/templates.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { AttachmentsService } from "../../src/conversations/attachments.service.js";
import {
  ConversationsService,
  type ResolvedExtra,
  type RunControl,
} from "../../src/conversations/conversations.service.js";
import { type EventBus, EventLog } from "../../src/conversations/event-log.js";
import type { LogContentBlock } from "../../src/conversations/events.js";
import { ConversationQueue } from "../../src/conversations/queue.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import type { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { KernelEvents } from "../../src/infra/events/kernel-events.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import type { SkillInvoker } from "../../src/skills/invoke.js";
import { handlesFor } from "./identity.js";

export { legacyDbFor } from "./identity.js";

const quiet = createLogger("error", { write: () => {} });

/** The event log over a test's pool and bus; `events` gets `conversation.event-appended`. */
export function eventLogFor(
  raw: Kysely<any>,
  bus: EventBus,
  events: KernelEvents = new KernelEvents(quiet),
): EventLog {
  const h = handlesFor(raw);
  return new EventLog(h.db, bus, quiet, events, h.txHost);
}

/** The agent templates over a test's pool. */
export function agentTemplatesFor(raw: Kysely<any>): AgentTemplatesService {
  return new AgentTemplatesService(handlesFor(raw).db);
}

/** The attachments service over a test's pool (none: a service that must not touch the database). */
export function attachmentsFor(d: {
  db?: Kysely<any>;
  storage: ConstructorParameters<typeof AttachmentsService>[1];
  config: () => KernelConfig;
  canAccessConversation: (
    orgId: string,
    conversationId: string,
    viewer: string,
  ) => Promise<boolean>;
  log: Pick<KernelLogger, "info" | "warn">;
}): AttachmentsService {
  const h = d.db === undefined ? undefined : handlesFor(d.db);
  return new AttachmentsService(
    h?.db ?? ({} as never),
    d.storage,
    { get: d.config },
    { isAccessible: d.canAccessConversation },
    d.log,
    h?.txHost ?? ({} as never),
  );
}

/** The database handles a hand-built service runs on: a test pool's, or the kernel app's. */
export interface DbHandles {
  db: KernelDb;
  txHost: TransactionHost;
}

/** A run control that starts and stops nothing (the old optional `runs` left out). */
const noRuns: RunControl = {
  ensureRun: async () => null,
  abortIfOrphaned: async () => false,
  abortWaiting: async () => false,
  requestAbort: async () => {},
};

/**
 * A conversations service over test doubles: what is left out refuses (`resolveAttachments`,
 * `bindFiles`, `invoker`, the model `providers`) or does nothing (`runs`).
 */
export function conversationsFor(
  h: DbHandles,
  d: {
    eventLog: EventLog;
    agents: Pick<AgentLookup, "get">;
    runs?: RunControl;
    resolveAttachments?: (
      orgId: string,
      accountId: string,
      refs: { connectorId: string; uri: string }[],
    ) => Promise<ResolvedExtra>;
    bindFiles?: (
      orgId: string,
      conversationId: string,
      accountId: string,
      ids: readonly string[],
    ) => Promise<LogContentBlock[]>;
    invoker?: Pick<SkillInvoker, "prepare">;
  },
): ConversationsService {
  const refuse = (what: string) => () => {
    throw new Error(`${what} is not available in this test`);
  };
  const invoker = d.invoker;
  return new ConversationsService(
    h.db,
    d.eventLog,
    d.agents,
    { isAccessible: async () => true },
    d.runs ?? noRuns,
    { resolve: refuse("providers") },
    quiet,
    { resolveAttachments: d.resolveAttachments ?? refuse("resolveAttachments") },
    { bindForMessage: d.bindFiles ?? refuse("bindFiles") },
    { prepare: invoker ? (a) => invoker.prepare(a) : refuse("invoker") },
    h.txHost,
  );
}

/** The queue over a hand-built conversations service. */
export function queueFor(
  h: DbHandles,
  d: { eventLog: EventLog; conversations: ConversationsService; runs?: RunControl },
): ConversationQueue {
  return new ConversationQueue(h.db, d.eventLog, d.conversations, d.runs ?? noRuns, h.txHost);
}
