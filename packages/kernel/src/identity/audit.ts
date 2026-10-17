import type { Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";

/** 写一条审计事件；`action` 用点分英文小写，如 `org.member.role_changed`。 */
export async function audit(
  db: KernelDb | Transaction<KernelDatabase>,
  e: {
    actorAccountId?: string;
    actorTokenId?: string;
    orgId?: string;
    action: string;
    target?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      actor_account_id: e.actorAccountId ?? null,
      actor_token_id: e.actorTokenId ?? null,
      org_id: e.orgId ?? null,
      action: e.action,
      target: e.target ?? null,
      detail: JSON.stringify(e.detail ?? {}),
    })
    .execute();
}
