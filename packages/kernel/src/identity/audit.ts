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

/**
 * Connector audit actions written before the D17 rename (old rows are not rewritten, C27) -> the
 * renamed action. Only these are listed, nothing is inferred from the `app.*` prefix: after D17
 * "app" meant app bundles (`app.installed` etc., `plugin.org_installed` since phase 0a), which are
 * unrelated to connectors (F-X).
 */
export const LEGACY_AUDIT_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  "app.created": "connector.created",
  "app.updated": "connector.updated",
  "app.deleted": "connector.deleted",
  "app.tools_refreshed": "connector.tools_refreshed",
  "app.tools_drifted": "connector.tools_drifted",
  "app.tool_reviewed": "connector.tool_reviewed",
  "app.credential.set": "connector.credential.set",
  "app.credential.cleared": "connector.credential.cleared",
});

/**
 * 按 action 查询审计时与之同义的全部 action（含自身）：`connector.created` ↔ `app.created` 等，
 * 只按 {@link LEGACY_AUDIT_ACTIONS} 显式映射；其余 action 只有自身。
 */
export function auditActionAliases(action: string): string[] {
  const current = LEGACY_AUDIT_ACTIONS[action] ?? action;
  const legacy = Object.entries(LEGACY_AUDIT_ACTIONS)
    .filter(([, to]) => to === current)
    .map(([from]) => from);
  return [current, ...legacy];
}
