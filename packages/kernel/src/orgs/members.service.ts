import type { Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { Account } from "../identity/accounts.js";
import { audit } from "../identity/audit.js";
import type { OrgRole } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

/** 发起成员变更的人：账号与其在该组织中的角色（由 OrgGuard 在请求时实时读出）。 */
export type MemberActor = { accountId: string; role: OrgRole };

export interface Member {
  account: Pick<Account, "id" | "displayName" | "email">;
  role: OrgRole;
  joinedAt: Date;
}

/**
 * 成员服务。所有写操作在事务内先 `SELECT … FROM orgs WHERE id = $1 FOR UPDATE`，
 * 把同一组织的成员变更串行化（多副本下两个 owner 并发互相降级也恰好剩一个 owner）。
 * 框架无关，由调用方注入 db。
 */
export class MembersService {
  constructor(private readonly db: KernelDb) {}

  async list(orgId: string): Promise<Member[]> {
    const rows = await this.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select([
        "accounts.id",
        "accounts.display_name",
        "accounts.email",
        "memberships.role",
        "memberships.created_at",
      ])
      .where("memberships.org_id", "=", orgId)
      .orderBy("memberships.created_at")
      .orderBy("accounts.id")
      .execute();
    return rows.map((r) => ({
      account: { id: r.id, displayName: r.display_name, email: r.email },
      role: r.role,
      joinedAt: r.created_at,
    }));
  }

  /** 加入成员（邀请接受等）；已是成员 → `member.already_exists`。`actorAccountId` 仅用于审计。 */
  async add(
    orgId: string,
    accountId: string,
    role: OrgRole,
    actorAccountId: string,
    trx?: Trx,
  ): Promise<void> {
    const run = async (t: Trx): Promise<void> => {
      await this.lockOrg(t, orgId);
      if (await this.roleIn(t, orgId, accountId)) {
        throw new ApiError("member.already_exists", "Account is already a member");
      }
      await t
        .insertInto("memberships")
        .values({ org_id: orgId, account_id: accountId, role })
        .execute();
      await audit(t, {
        actorAccountId,
        orgId,
        action: "org.member.added",
        target: accountId,
        detail: { role },
      });
    };
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  /**
   * 改角色：授予或撤销 owner、或改动一个 owner，只有 owner 能做（`org.owner_required`）；
   * admin 只能在 guest / member / admin 之间调整非 owner。操作后 owner 数为 0 → `org.last_owner`。
   */
  async changeRole(
    orgId: string,
    targetId: string,
    role: OrgRole,
    actor: MemberActor,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await this.lockOrg(t, orgId);
      const before = await this.requireMember(t, orgId, targetId);
      if ((role === "owner" || before === "owner") && actor.role !== "owner") {
        throw new ApiError("org.owner_required", "Only an owner can change owner roles");
      }
      if (before === role) return;
      await this.setRole(t, orgId, targetId, role);
      await this.assertHasOwner(t, orgId);
      await audit(t, {
        actorAccountId: actor.accountId,
        orgId,
        action: "org.member.role_changed",
        target: targetId,
        detail: { from: before, to: role },
      });
    });
  }

  /** 移出成员：权限规则同 changeRole；移除最后一个 owner → `org.last_owner`；同一事务清空其会话的当前组织。 */
  async remove(orgId: string, targetId: string, actor: MemberActor): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await this.lockOrg(t, orgId);
      const before = await this.requireMember(t, orgId, targetId);
      if (before === "owner" && actor.role !== "owner") {
        throw new ApiError("org.owner_required", "Only an owner can remove an owner");
      }
      await this.deleteMember(t, orgId, targetId);
      await audit(t, {
        actorAccountId: actor.accountId,
        orgId,
        action: "org.member.removed",
        target: targetId,
        detail: { role: before },
      });
    });
  }

  /** 主动离开；最后一个 owner → `org.last_owner`。 */
  async leave(orgId: string, accountId: string): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await this.lockOrg(t, orgId);
      const before = await this.requireMember(t, orgId, accountId);
      await this.deleteMember(t, orgId, accountId);
      await audit(t, {
        actorAccountId: accountId,
        orgId,
        action: "org.member.left",
        target: accountId,
        detail: { role: before },
      });
    });
  }

  /** 转让所有权：from 必须是 owner（`org.owner_required`）；to 必须是成员（`member.not_found`）；to → owner、from → admin。 */
  async transferOwnership(
    orgId: string,
    fromAccountId: string,
    toAccountId: string,
  ): Promise<void> {
    if (fromAccountId === toAccountId) {
      throw new ApiError("validation_failed", "Cannot transfer ownership to yourself");
    }
    await this.db.transaction().execute(async (t) => {
      await this.lockOrg(t, orgId);
      const fromRole = await this.roleIn(t, orgId, fromAccountId);
      if (fromRole !== "owner") {
        throw new ApiError("org.owner_required", "Only an owner can transfer ownership");
      }
      const toRole = await this.requireMember(t, orgId, toAccountId);
      await this.setRole(t, orgId, toAccountId, "owner");
      await this.setRole(t, orgId, fromAccountId, "admin");
      await audit(t, {
        actorAccountId: fromAccountId,
        orgId,
        action: "org.ownership_transferred",
        target: toAccountId,
        detail: {
          from: fromAccountId,
          to: toAccountId,
          fromRole: { before: fromRole, after: "admin" },
          toRole: { before: toRole, after: "owner" },
        },
      });
    });
  }

  /** 锁住组织行，串行化同一组织的成员变更；组织不存在或已软删除 → `org.not_found`。 */
  private async lockOrg(t: Trx, orgId: string): Promise<void> {
    const row = await t
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new ApiError("org.not_found", "Organization not found");
  }

  private async roleIn(t: Trx, orgId: string, accountId: string): Promise<OrgRole | undefined> {
    const r = await t
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return r?.role;
  }

  private async requireMember(t: Trx, orgId: string, accountId: string): Promise<OrgRole> {
    const role = await this.roleIn(t, orgId, accountId);
    if (!role) throw new ApiError("member.not_found", "Member not found");
    return role;
  }

  private async setRole(t: Trx, orgId: string, accountId: string, role: OrgRole): Promise<void> {
    await t
      .updateTable("memberships")
      .set({ role, updated_at: new Date() })
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .execute();
  }

  /** 删除成员关系、检查仍有 owner、清空该账号指向此组织的会话当前组织。 */
  private async deleteMember(t: Trx, orgId: string, accountId: string): Promise<void> {
    await t
      .deleteFrom("memberships")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .execute();
    await this.assertHasOwner(t, orgId);
    await t
      .updateTable("sessions")
      .set({ current_org_id: null })
      .where("account_id", "=", accountId)
      .where("current_org_id", "=", orgId)
      .execute();
  }

  private async assertHasOwner(t: Trx, orgId: string): Promise<void> {
    const r = await t
      .selectFrom("memberships")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();
    if (Number(r.n) === 0) {
      throw new ApiError("org.last_owner", "An organization must keep at least one owner");
    }
  }
}
