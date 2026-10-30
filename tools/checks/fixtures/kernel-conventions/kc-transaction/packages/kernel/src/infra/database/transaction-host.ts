import type { Transaction } from "kysely";

export async function run(db: { transaction(): { execute(f: (t: Transaction<unknown>) => Promise<void>): Promise<void> } }) {
  await db.transaction().execute(async () => {});
}

export const join = (trx: unknown) => trx;
