import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { LEGACY_AUDIT_ACTIONS } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";

/**
 * One platform-level audit event (admin overview spec §5.2, §9): who, what, on what and when, and
 * two flags. Never the event's `detail` (it may carry config field names or ids); a deleted actor
 * account reads as its id with a null name and email; `actor` is null for the kernel itself.
 */
export interface PlatformAuditEvent {
  /** The event id (a bigserial, as a decimal string); also the keyset cursor. */
  id: string;
  at: string;
  actor: { id: string; name: string | null; email: string | null } | null;
  /** Done with a personal access token. */
  viaToken: boolean;
  /** Done through the Platform tool by the actor's own agent (`detail.via === "agent"`). */
  viaAgent: boolean;
  /** The action; a legacy name is mapped through {@link LEGACY_AUDIT_ACTIONS}. */
  action: string;
  target: string | null;
}

/** A page of {@link PlatformAuditEvent}s; `next` is the `after` of the next page, null at the end. */
export interface PlatformAuditPage {
  events: PlatformAuditEvent[];
  next: string | null;
}

/**
 * Reads the platform-level audit log: events with no org (`org_id IS NULL`, decision D3), newest
 * first by id, keyset paged (`audit_events_platform_idx`). Read-only and not audited (D5).
 */
@Injectable()
export class PlatformAuditService {
  constructor(@Inject(KernelDb) private readonly kdb: KernelDb) {}

  /** `limit` events with an id below `after` (from the newest without it); one extra row tells `next`. */
  async list(q: { after?: string | undefined; limit: number }): Promise<PlatformAuditPage> {
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
        // only the one flag the overview shows, never the whole detail (spec §9)
        sql<string | null>`a.detail->>'via'`.as("via"),
      ])
      .where("a.org_id", "is", null);
    if (q.after !== undefined) query = query.where("a.id", "<", q.after);
    const rows = await query
      .orderBy("a.id", "desc")
      .limit(q.limit + 1)
      .execute();
    const events = rows.slice(0, q.limit).map(
      (r): PlatformAuditEvent => ({
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
        action: LEGACY_AUDIT_ACTIONS[r.action] ?? r.action,
        target: r.target,
      }),
    );
    const next = rows.length > q.limit ? (events.at(-1)?.id ?? null) : null;
    return { events, next };
  }
}
