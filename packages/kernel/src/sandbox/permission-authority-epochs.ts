import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import {
  type AuthorityLevel,
  type AuthoritySubject,
  authorityEntries,
  PermissionAuthorityLock,
} from "./permission-authority-lock.js";
export type AuthorityEpochVector = {
  platform: number;
  org: number | null;
  device: number | null;
  root: number | null;
};
@Injectable()
export class PermissionAuthorityEpochStore {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
  ) {}
  @Transactional({ propagation: "mandatory" })
  async readLocked(subject: AuthoritySubject): Promise<AuthorityEpochVector> {
    const result: AuthorityEpochVector = { platform: 0, org: null, device: null, root: null };
    for (const [kind, id] of authorityEntries(subject)) {
      this.locks.assertHeld(kind, id);
      result[kind] = await this.read(kind, id);
    }
    return result;
  }
  private async read(kind: AuthorityLevel, id: string): Promise<number> {
    let row = await this.db
      .selectFrom("permission_authority_epochs")
      .select("revision")
      .where("kind", "=", kind)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      await this.db
        .insertInto("permission_authority_epochs")
        .values({ kind, id })
        .onConflict((oc) => oc.columns(["kind", "id"]).doNothing())
        .execute();
      row = await this.db
        .selectFrom("permission_authority_epochs")
        .select("revision")
        .where("kind", "=", kind)
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    }
    return row.revision;
  }
  @Transactional({ propagation: "mandatory" })
  async bumpLocked(kind: AuthorityLevel, id: string, expected: number): Promise<number> {
    this.locks.assertHeld(kind, id, true);
    await this.read(kind, id);
    const row = await this.db
      .updateTable("permission_authority_epochs")
      .set({ revision: expected + 1 })
      .where("kind", "=", kind)
      .where("id", "=", id)
      .where("revision", "=", expected)
      .returning("revision")
      .executeTakeFirst();
    if (!row) throw new ApiError("conflict", "Authority changed; refresh and retry");
    return row.revision;
  }
}
