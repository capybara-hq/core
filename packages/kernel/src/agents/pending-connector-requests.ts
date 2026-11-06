import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";

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

  /** The request for a new agent, requested by its owner (ruling P4-T6-4). */
  async openFor(args: PendingConnectorRequestArgs): Promise<void> {
    await this.open({
      orgId: args.orgId,
      agentId: args.agentId,
      requestedBy: args.ownerAccountId,
      keys: args.keys,
      actor: args.ownerAccountId,
    });
  }

  /**
   * Opens a pending `connector_setup` request for `keys` unless the agent has one (then that one,
   * unchanged). Audits `catalog.requested` for a new one. Joins the caller's transaction.
   */
  @Transactional()
  async open(a: {
    orgId: string;
    agentId: string;
    requestedBy: string;
    keys: readonly string[];
    actor: string;
    actorTokenId?: string | undefined;
  }): Promise<{ id: string; created: boolean }> {
    const t = this.kdb.db;
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
        pending_keys: JSON.stringify([...a.keys]),
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
    if (inserted === undefined) {
      const existing = await t
        .selectFrom("catalog_requests")
        .select("id")
        .where("agent_id", "=", a.agentId)
        .where("kind", "=", "connector_setup")
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();
      return { id: existing.id, created: false };
    }
    await audit(t, {
      actorAccountId: a.actor,
      ...(a.actorTokenId !== undefined && { actorTokenId: a.actorTokenId }),
      orgId: a.orgId,
      action: "catalog.requested",
      target: id,
      detail: { kind: "connector_setup", agentId: a.agentId, keys: [...a.keys] },
    });
    return { id, created: true };
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
