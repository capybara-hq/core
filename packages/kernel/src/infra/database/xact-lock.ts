import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "./kernel-db.js";
import { assertNotSharedAdmission, TransactionHost } from "./transaction-host.js";
import { Transactional } from "./transactional.decorator.js";

/**
 * Transaction-scoped advisory locks (decision R9 of the Nest kernel spec): `pg_advisory_xact_lock`
 * is transaction semantics, like `FOR UPDATE`. It is held by the caller's transaction and released
 * at its COMMIT or ROLLBACK, so it serializes writers whose invariant is checked inside that same
 * transaction ("never zero active super admins", "set up once", "one account per external
 * identity"). The one place that takes such a lock; `propagation: "mandatory"` makes a call outside
 * a transaction (where the lock would be released at once) throw.
 */
@Injectable()
export class XactLock {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async shared(key: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${key}))`.execute(this.db.db);
  }

  /** Takes the lock named `key` until the caller's transaction ends (waits while another holds it). */
  @Transactional({ propagation: "mandatory" })
  async lock(key: string): Promise<void> {
    assertNotSharedAdmission(`the advisory lock ${key}`);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(this.db.db);
  }

  /**
   * The org admission lock in its shared mode: the run fence admitting a run's hot-path write
   * (`RunExecution`). Shared holders never wait for each other; they wait for an exclusive holder,
   * and also queue behind an exclusive waiter (PostgreSQL grants heavyweight locks in order), so
   * org deletion and offboarding are never starved by a stream of run writes. Two-key form
   * ({@link ORG_ADMISSION_SPACE}, org id): a key space apart from {@link lock}'s one-key locks.
   */
  @Transactional({ propagation: "mandatory" })
  async admitOrgShared(orgId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtext(${ORG_ADMISSION_SPACE}), hashtext(${orgId}))`.execute(
      this.db.db,
    );
  }

  /**
   * The org admission lock in its exclusive mode: org deletion and offboarding (`OrgLock`), taken
   * first in their transaction. Waits for every admitted hot-path write of the org and keeps new
   * ones out until the transaction ends.
   */
  @Transactional({ propagation: "mandatory" })
  async admitOrgExclusive(orgId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${ORG_ADMISSION_SPACE}), hashtext(${orgId}))`.execute(
      this.db.db,
    );
  }
}

/** The first key of the org admission lock ({@link XactLock.admitOrgShared}). */
export const ORG_ADMISSION_SPACE = "capybara.org-admission";
