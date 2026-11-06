import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import type { AgentDefinition } from "./definition.js";

/**
 * Moves the agents' setup requests that still concern their owner (pending, or decided and not
 * dismissed) to the new owner `owner` (an owner change: `AgentsService.reassignOwner`, member
 * offboarding). Runs through `db` (the caller's transaction).
 */
export async function retargetSetupRequests(
  db: KernelSchemaDb,
  agentIds: readonly string[],
  owner: string,
): Promise<void> {
  if (agentIds.length === 0) return;
  await db
    .updateTable("catalog_requests")
    .set({ requested_by: owner })
    .where("kind", "=", "connector_setup")
    .where("agent_id", "in", [...agentIds])
    .where((eb) =>
      eb.or([
        eb("status", "=", "pending"),
        eb.and([eb("status", "in", ["approved", "rejected"]), eb("dismissed_at", "is", null)]),
      ]),
    )
    .execute();
}

/** What {@link PendingConnectorRequests.openFor} receives: plain values, no transaction. */
export interface PendingConnectorRequestArgs {
  orgId: string;
  agentId: string;
  ownerAccountId: string;
  /** The `pendingConnectors[].key`s of the new agent's version 1. */
  keys: string[];
}

/** How a request ends when no key is left (ruling P4-T6-3). */
export type PendingRequestClose = "approved" | "cancelled";

/**
 * The org inbox requests for an agent's pending connectors (ruling P4-7: one `connector_setup`
 * request per agent, visible to org admins, kept unique by the partial index
 * `catalog_requests_pending_setup_uq`). Creating an agent from a template calls {@link openFor}
 * after the commit when the creator lacks `connectors.manage`; the agent's owner or an admin
 * re-opens one (`PendingConnectorsService.reopen`); every definition write that changes the
 * agent's pending connectors settles the pending request in its transaction ({@link settleIn}):
 * the keys narrow, and with none left it closes (`approved` after a bind, `cancelled` after an
 * edit removed them or the agent was deleted; ruling P4-T6-3). Rejecting is the org admins' (the
 * catalog requests' decide route). No in-process state.
 */
@Injectable()
export class PendingConnectorRequests {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * The request for a new agent, requested by its owner (ruling P4-T6-4). `args.keys` are what the
   * create saw; {@link open} reads the agent's pending keys again under its row.
   */
  async openFor(args: PendingConnectorRequestArgs): Promise<void> {
    await this.open({
      orgId: args.orgId,
      agentId: args.agentId,
      requestedBy: args.ownerAccountId,
      actor: args.ownerAccountId,
    });
  }

  /**
   * Opens a pending `connector_setup` request for the agent's current pending connector keys (read
   * under the agent row, `FOR NO KEY UPDATE` as `AgentsService.lockForWrite` takes it) unless the
   * agent has one (then that one, unchanged). Null when the agent is gone (deleted, another org)
   * or has no pending connectors (fix round 1, item 7). Audits `catalog.requested` for a new one.
   * Joins the caller's transaction.
   */
  @Transactional()
  async open(a: {
    orgId: string;
    agentId: string;
    requestedBy: string;
    actor: string;
    actorTokenId?: string | undefined;
  }): Promise<{ id: string; created: boolean } | null> {
    const t = this.kdb.db;
    const agent = await t
      .selectFrom("agents")
      .select("current_version")
      .where("id", "=", a.agentId)
      .where("org_id", "=", a.orgId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!agent) return null;
    const version = await t
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", a.agentId)
      .where("version", "=", agent.current_version)
      .executeTakeFirstOrThrow();
    const keys = (
      (version.definition as Pick<AgentDefinition, "pendingConnectors">).pendingConnectors ?? []
    ).map((c) => c.key);
    if (keys.length === 0) return null;
    // a pending request decided between the conflict and the read: insert again (twice at most)
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = randomUUID();
      const inserted = await t
        .insertInto("catalog_requests")
        .values({
          id,
          org_id: a.orgId,
          item_id: null,
          kind: "connector_setup",
          // still written for the old NOT NULL / CHECK, never read
          stage: "org",
          agent_id: a.agentId,
          pending_keys: JSON.stringify(keys),
          requested_by: a.requestedBy,
          note: "",
        })
        // the partial index of pending setup requests (a literal predicate: inference needs it)
        .onConflict((oc) =>
          oc
            .column("agent_id")
            .where(sql<boolean>`kind = 'connector_setup' AND status = 'pending'`)
            .doNothing(),
        )
        .returning("id")
        .executeTakeFirst();
      if (inserted !== undefined) {
        await audit(t, {
          actorAccountId: a.actor,
          ...(a.actorTokenId !== undefined && { actorTokenId: a.actorTokenId }),
          orgId: a.orgId,
          action: "catalog.requested",
          target: id,
          detail: { kind: "connector_setup", agentId: a.agentId, keys },
        });
        return { id, created: true };
      }
      const existing = await t
        .selectFrom("catalog_requests")
        .select("id")
        .where("agent_id", "=", a.agentId)
        .where("kind", "=", "connector_setup")
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (existing) return { id: existing.id, created: false };
    }
    throw new Error(`cannot open the connector setup request of agent ${a.agentId}`);
  }

  /**
   * The agent's new owner receives its setup request's decision (fix round 1, item 4): the pending
   * request and the decided ones not dismissed move to `owner`. In the caller's transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async retargetIn(agentIds: readonly string[], owner: string): Promise<void> {
    await retargetSetupRequests(this.kdb.db, agentIds, owner);
  }

  /**
   * Settles the agent's pending request after a definition write, in the caller's transaction
   * (it holds the agent row lock): `keys` are the agent's pending connector keys now. The request
   * keeps the ones still pending; with none left it closes as `close`, decided by `actor` (a close
   * the requester made themself needs no notice: it is dismissed at once). Audits
   * `catalog.request_closed` on a close.
   */
  @Transactional({ propagation: "mandatory" })
  async settleIn(a: {
    orgId: string;
    agentId: string;
    keys: readonly string[];
    close: PendingRequestClose;
    actor: string;
    actorTokenId?: string | undefined;
  }): Promise<void> {
    const t = this.kdb.db;
    const row = await t
      .selectFrom("catalog_requests")
      .select(["id", "pending_keys", "requested_by"])
      .where("agent_id", "=", a.agentId)
      .where("kind", "=", "connector_setup")
      .where("status", "=", "pending")
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    const before = row.pending_keys ?? [];
    const left = before.filter((k) => a.keys.includes(k));
    if (left.length > 0) {
      if (left.length !== before.length) {
        await t
          .updateTable("catalog_requests")
          .set({ pending_keys: JSON.stringify(left) })
          .where("id", "=", row.id)
          .execute();
      }
      return;
    }
    await t
      .updateTable("catalog_requests")
      .set({
        status: a.close,
        pending_keys: JSON.stringify([]),
        decided_by: a.actor,
        decided_at: sql<Date>`now()`,
        ...(a.close === "approved" &&
          row.requested_by === a.actor && { dismissed_at: sql<Date>`now()` }),
      })
      .where("id", "=", row.id)
      .execute();
    await audit(t, {
      actorAccountId: a.actor,
      ...(a.actorTokenId !== undefined && { actorTokenId: a.actorTokenId }),
      orgId: a.orgId,
      action: "catalog.request_closed",
      target: row.id,
      detail: { kind: "connector_setup", agentId: a.agentId, status: a.close },
    });
  }
}
