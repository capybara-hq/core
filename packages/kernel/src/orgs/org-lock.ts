import { Inject, Injectable, Module } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { can, type OrgAction, type OrgRole } from "./roles.js";

/** The locked org's metadata (audits record the values before a change). */
export interface LockedOrg {
  slug: string;
  name: string;
}

/**
 * The org row lock that serializes an organization's member / invitation / token / config writes.
 * Every method joins the caller's transaction (`mandatory`), which holds the row lock until it
 * ends; called outside one it throws instead of locking nothing.
 *
 * NO KEY UPDATE, not UPDATE: the holders still exclude each other (and `FOR SHARE` readers), but a
 * foreign key check against the org row (`FOR KEY SHARE`, taken by every insert of a row that
 * references the org, and by an update of a row the same transaction already wrote) is not blocked.
 * With FOR UPDATE, offboarding (org row, then the member's conversations) deadlocked with an event
 * log append (a conversation row, then the org foreign key check).
 */
@Injectable()
export class OrgLock {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** Locks the org row; undefined when the org does not exist or is soft-deleted. */
  @Transactional({ propagation: "mandatory" })
  async tryLock(orgId: string): Promise<LockedOrg | undefined> {
    return this.db
      .selectFrom("orgs")
      .select(["slug", "name"])
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }

  /** Like {@link tryLock}; a missing or soft-deleted org → `org.not_found`. */
  @Transactional({ propagation: "mandatory" })
  async lock(orgId: string): Promise<LockedOrg> {
    const org = await this.tryLock(orgId);
    if (!org) throw new ApiError("org.not_found", "Organization not found");
    return org;
  }

  /**
   * The run-time re-check of a role-dependent org write (spec 3.6 R5): locks the org row and
   * re-reads the actor's role under it. A missing or soft-deleted org → `org.not_found`; the actor
   * is not a member or the role does not allow `action` → `forbidden`. Services take only the
   * actor's account id, never a role from the caller.
   */
  @Transactional({ propagation: "mandatory" })
  async lockAndAuthorize(
    orgId: string,
    actorAccountId: string,
    action: OrgAction,
  ): Promise<{ org: LockedOrg; role: OrgRole }> {
    const org = await this.lock(orgId);
    const m = await this.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", actorAccountId)
      .executeTakeFirst();
    if (!m || !can(m.role, action)) {
      throw new ApiError("forbidden", "Insufficient organization role");
    }
    return { org, role: m.role };
  }
}

/** The one {@link OrgLock}: identity (service tokens), orgs and the other domains import it. */
@Module({ providers: [OrgLock], exports: [OrgLock] })
export class OrgLockModule {}
