import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import {
  PUSH_CATEGORIES,
  type PushCategory,
  type PushPreferences,
  type PushPreferencesPatch,
} from "./push.schemas.js";

/**
 * A person's push category switches (mobile app spec §9.4): one row per category switched, an
 * absent row is on. They belong to the account and apply in every org.
 */
@Injectable()
export class PushPreferencesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The four switches of `accountId`. */
  async get(accountId: string): Promise<PushPreferences> {
    const rows = await this.db
      .selectFrom("push_preferences")
      .select(["category", "enabled"])
      .where("account_id", "=", accountId)
      .execute();
    const out: PushPreferences = { waiting: true, replies: true, tasks: true, schedules: true };
    for (const r of rows) out[r.category] = r.enabled;
    return out;
  }

  /** Sets the switches given (the others keep their value) and answers all four. */
  @Transactional()
  async set(accountId: string, patch: PushPreferencesPatch): Promise<PushPreferences> {
    const values = PUSH_CATEGORIES.flatMap((category) => {
      const enabled = patch[category];
      return enabled === undefined ? [] : [{ account_id: accountId, category, enabled }];
    });
    if (values.length > 0) {
      await this.db
        .insertInto("push_preferences")
        .values(values)
        .onConflict((oc) =>
          oc.columns(["account_id", "category"]).doUpdateSet((eb) => ({
            enabled: eb.ref("excluded.enabled"),
            updated_at: sql<Date>`now()`,
          })),
        )
        .execute();
    }
    return this.get(accountId);
  }

  /** The accounts among `accountIds` that have `category` on. */
  async enabledFor(accountIds: readonly string[], category: PushCategory): Promise<Set<string>> {
    const out = new Set(accountIds);
    if (out.size === 0) return out;
    const off = await this.db
      .selectFrom("push_preferences")
      .select("account_id")
      .where("account_id", "in", [...out])
      .where("category", "=", category)
      .where("enabled", "=", false)
      .execute();
    for (const r of off) out.delete(r.account_id);
    return out;
  }
}
