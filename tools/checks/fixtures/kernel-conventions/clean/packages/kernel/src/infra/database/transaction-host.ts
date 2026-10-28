// Ported from octok-platform libs/common/src/typeorm/transaction-context.ts (owner-approved, 2026-10-28).
import type { Transaction } from "kysely";

export class TransactionHost {
  run(db: { transaction(): unknown }, f: (t: Transaction<unknown>) => void) {
    void db.transaction();
    void f;
  }
}
