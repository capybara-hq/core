import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";

/**
 * One audit event (admin overview spec §5.2, §9): who, what, on what and when, and two flags.
 * Never the event's `detail` (it may carry config field names, ids or values); a deleted actor
 * account reads as its id with a null name and email; `actor` is null for the kernel itself.
 */
export interface AuditEvent {
  /** The event id (a bigserial, as a decimal string); also the keyset cursor. */
  id: string;
  at: string;
  actor: { id: string; name: string | null; email: string | null } | null;
  /** Done with a personal access token. */
  viaToken: boolean;
  /** Done through the Platform tool by the actor's own agent (`detail.via === "agent"`). */
  viaAgent: boolean;
  /** The action. */
  action: string;
  target: string | null;
}

/** A page of {@link AuditEvent}s; `next` is the `after` of the next page, null at the end. */
export interface AuditPage {
  events: AuditEvent[];
  next: string | null;
}

/** Whose events: the platform's (`org_id IS NULL`, decision D3) or one org's. */
export type AuditScope = { platform: true } | { orgId: string };

export interface AuditListQuery {
  after?: string | undefined;
  limit: number;
  /** Only actions starting with this prefix. */
  action?: string | undefined;
}

/** `prefix` as a LIKE pattern matching the strings that start with it. */
const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Reads the audit log of one scope: the platform's (the admin console's Audit log) or one org's (the
 * org settings' Audit log, and the super admin's view of an org), newest first by id, keyset paged
 * (`audit_events_platform_idx` / `audit_events_org_id_idx`). Read-only and not audited (D5).
 */
@Injectable()
export class AuditLogService {
  constructor(@Inject(KernelDb) private readonly kdb: KernelDb) {}

  /** `limit` events with an id below `after` (from the newest without it); one extra row tells `next`. */
  async list(scope: AuditScope, q: AuditListQuery): Promise<AuditPage> {
    let query = this.kdb.db
      .selectFrom("audit_events as a")
      .leftJoin("accounts as ac", "ac.id", "a.actor_account_id")
      .select([
        "a.id",
        "a.at",
        "a.actor_account_id",
        "a.actor_token_id",
        "a.action",
        "a.target",
        "ac.display_name",
        "ac.email",
        // only the one flag the log shows, never the whole detail (spec §9)
        sql<string | null>`a.detail->>'via'`.as("via"),
      ]);
    query =
      "orgId" in scope
        ? query.where("a.org_id", "=", scope.orgId)
        : query.where("a.org_id", "is", null);
    if (q.after !== undefined) query = query.where("a.id", "<", q.after);
    if (q.action !== undefined) {
      query = query.where("a.action", "like", likePrefix(q.action));
    }
    const rows = await query
      .orderBy("a.id", "desc")
      .limit(q.limit + 1)
      .execute();
    const events = rows.slice(0, q.limit).map(
      (r): AuditEvent => ({
        id: String(r.id),
        at: r.at.toISOString(),
        actor:
          r.actor_account_id === null
            ? null
            : {
                id: r.actor_account_id,
                name: r.display_name ?? null,
                email: r.email ?? null,
              },
        viaToken: r.actor_token_id !== null,
        viaAgent: r.via === "agent",
        action: r.action,
        target: r.target,
      }),
    );
    const next = rows.length > q.limit ? (events.at(-1)?.id ?? null) : null;
    return { events, next };
  }
}
