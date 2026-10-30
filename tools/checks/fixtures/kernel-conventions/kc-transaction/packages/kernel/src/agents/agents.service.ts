import type { Transaction } from "kysely";
import type { Db } from "../db/kernel-schema.js";

export async function save(db: Db, trx: Transaction<Db>): Promise<void> { // expect: kc-transaction
  await db.transaction().execute(async () => {}); // expect: kc-transaction
  const t = await db.startTransaction().execute(); // expect: kc-transaction
  if (db.isTransaction) return; // expect: kc-transaction
  void trx;
  void t;
}

export async function insert(db: KernelSchemaDb | Transaction<Db>): Promise<void> { // expect: kc-transaction
  void db;
}
export const write = async (tx: unknown, trxCount: number) => { // expect: kc-transaction
  void tx;
  void trxCount;
};
export class Repo {
  async put(trx: unknown): Promise<void> { // expect: kc-transaction
    void trx;
  }
}
