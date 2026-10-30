// biome-ignore-all lint/suspicious/noExplicitAny: the pool carries no schema types
import type { Kysely } from "kysely";
import { SetupLock } from "../../src/admin/setup-lock.js";
import { EnterpriseAdminLock } from "../../src/identity/enterprise-admin.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import type { KernelLogger } from "../../src/log.js";

/** The database handles of {@link databaseHandles}. */
export interface DatabaseHandles {
  db: KernelDb;
  txHost: TransactionHost;
  xactLock: XactLock;
  /** The lock providers over these handles (the same classes the application provides). */
  adminLock: EnterpriseAdminLock;
  setupLock: SetupLock;
}

/**
 * The handles `DatabaseModule` provides, over a pool the test owns, for unit tests that build a
 * few providers without an application (code outside tests opens a context with
 * `openKernelCliOverPool` instead).
 */
export function databaseHandles(pool: Kysely<any>, log: KernelLogger): DatabaseHandles {
  const txHost = new TransactionHost(pool, log);
  const db = new KernelDb(pool, txHost);
  const xactLock = new XactLock(db, txHost);
  return {
    db,
    txHost,
    xactLock,
    adminLock: new EnterpriseAdminLock(db, xactLock, txHost),
    setupLock: new SetupLock(xactLock, txHost),
  };
}
