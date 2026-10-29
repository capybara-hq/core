import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "./kernel-db.js";
import { TransactionHost } from "./transaction-host.js";
import { Transactional } from "./transactional.decorator.js";

/**
 * Transaction-scoped advisory locks (decision R9 of the Nest kernel spec): `pg_advisory_xact_lock`
 * is transaction semantics, like `FOR UPDATE`. It is held by the caller's transaction and released
 * at its COMMIT or ROLLBACK, so it serializes writers whose invariant is checked inside that same
 * transaction ("never zero active enterprise admins", "set up once", "one account per external
 * identity"). The one place that takes such a lock; `propagation: "mandatory"` makes a call outside
 * a transaction (where the lock would be released at once) throw.
 */
@Injectable()
export class XactLock {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** Takes the lock named `key` until the caller's transaction ends (waits while another holds it). */
  @Transactional({ propagation: "mandatory" })
  async lock(key: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(this.db.db);
  }
}
