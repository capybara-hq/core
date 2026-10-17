import { sql, type Transaction } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";

/**
 * 企业管理员写操作的执行期复核（spec 3.6 R5）：在调用方事务内取 `capybara.enterprise_admins` 咨询锁，
 * 串行化所有企业管理员写操作（撤销 / 停用 / 新建管理员 / 改部署设置），并在锁内实时确认发起人仍是活跃企业管理员，
 * 否则 `forbidden`。鉴权守卫在请求开头读到的身份可能已过期（另一个管理员刚撤销了他），必须在锁内重读。
 */
export async function lockEnterpriseAdminsAndAuthorize(
  trx: Transaction<KernelDatabase>,
  actorAccountId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext('capybara.enterprise_admins'))`.execute(trx);
  const actor = await trx
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", actorAccountId)
    .where("is_enterprise_admin", "=", true)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) throw new ApiError("forbidden", "Enterprise admin required");
}
