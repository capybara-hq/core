import { Inject, Injectable, Module } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/**
 * The transaction-scoped lock (`XactLock`, R9) that serializes every enterprise admin write:
 * revoke / disable / create an admin, deployment settings, prices, purposes, the catalog and
 * extension admin writes, the CLI's `capybara admin grant|revoke`.
 */
const ENTERPRISE_ADMINS_LOCK = "capybara.enterprise_admins";

/**
 * The run-time re-check of an enterprise admin write (spec 3.6 R5), under
 * {@link ENTERPRISE_ADMINS_LOCK}: the actor must still be an active enterprise admin, else
 * `forbidden`. The identity the auth guard read at the start of the request may be stale (another
 * admin just revoked it), so it is re-read under the lock.
 */
async function assertActiveEnterpriseAdmin(
  db: KernelSchemaDb,
  actorAccountId: string,
): Promise<void> {
  const actor = await db
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", actorAccountId)
    .where("is_enterprise_admin", "=", true)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) throw new ApiError("forbidden", "Enterprise admin required");
}

/**
 * The enterprise admin lock (R9 / R12), the one implementation of "lock, then re-check the actor":
 * both methods join the caller's transaction (`mandatory`), which holds the lock until it ends.
 */
@Injectable()
export class EnterpriseAdminLock {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** Only the lock (callers without an actor: the CLI, bootstrap). */
  @Transactional({ propagation: "mandatory" })
  async lock(): Promise<void> {
    await this.xactLock.lock(ENTERPRISE_ADMINS_LOCK);
  }

  /** The lock, then {@link assertActiveEnterpriseAdmin} under it. */
  @Transactional({ propagation: "mandatory" })
  async lockAndAuthorize(actorAccountId: string): Promise<void> {
    await this.xactLock.lock(ENTERPRISE_ADMINS_LOCK);
    await assertActiveEnterpriseAdmin(this.db.db, actorAccountId);
  }
}

/** The one {@link EnterpriseAdminLock}: identity, models, the extensions and the catalog import it. */
@Module({ providers: [EnterpriseAdminLock], exports: [EnterpriseAdminLock] })
export class EnterpriseAdminLockModule {}
