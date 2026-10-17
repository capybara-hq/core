import type { Transaction } from "kysely";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { can, type OrgAction, type OrgRole } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

/** 被锁组织的元数据（审计记录改动前的值用）。 */
export interface LockedOrg {
  slug: string;
  name: string;
}

/**
 * `SELECT … FROM capybara.orgs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`：锁住组织行，
 * 串行化同一组织的成员 / 邀请 / 令牌 / 配置写操作。组织不存在或已软删除时返回 undefined。
 */
export async function tryLockOrg(t: Trx, orgId: string): Promise<LockedOrg | undefined> {
  return t
    .selectFrom("orgs")
    .select(["slug", "name"])
    .where("id", "=", orgId)
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
}

/** 同 `tryLockOrg`，组织不存在或已软删除 → `org.not_found`。 */
export async function lockOrg(t: Trx, orgId: string): Promise<LockedOrg> {
  const org = await tryLockOrg(t, orgId);
  if (!org) throw new ApiError("org.not_found", "Organization not found");
  return org;
}

/**
 * 依赖角色的组织写操作的执行期复核（spec 3.6 R5）：锁组织行，并在锁内实时重读发起人的角色。
 * 组织不存在或已软删除 → `org.not_found`；发起人不是成员或角色不足以执行 `action` → `forbidden`。
 * 服务只接收发起人账号 id，不接收调用方传入的角色。
 */
export async function lockOrgAndAuthorize(
  t: Trx,
  orgId: string,
  actorAccountId: string,
  action: OrgAction,
): Promise<{ org: LockedOrg; role: OrgRole }> {
  const org = await lockOrg(t, orgId);
  const m = await t
    .selectFrom("memberships")
    .select("role")
    .where("org_id", "=", orgId)
    .where("account_id", "=", actorAccountId)
    .executeTakeFirst();
  if (!m || !can(m.role, action)) {
    throw new ApiError("forbidden", "Insufficient organization role");
  }
  return { org, role: m.role };
}
