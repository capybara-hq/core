import type { Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { Account } from "../identity/accounts.js";
import { audit } from "../identity/audit.js";
import type { Offboarding, OffboardResult } from "./offboarding.js";
import { lockOrg, lockOrgAndAuthorize } from "./org-lock.js";
import type { OrgRole } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

export interface Member {
  account: Pick<Account, "id" | "displayName" | "email">;
  role: OrgRole;
  joinedAt: Date;
  /** 该组织的匿名访客（渠道连接的匿名策略用）：不能改角色、移出、转让所有权或指派为 agent 负责人。 */
  anonymous: boolean;
}

/**
 * 账号是不是某个组织的匿名访客（`org_anonymous_accounts`）。匿名访客没有登录方式，只能以 guest 身份
 * 代表 IM 里未绑定的人：不能被授予别的角色、成为 owner、指派为 agent 负责人、加入别的组织或被移出。
 */
export async function isAnonymousGuest(db: KernelDb | Trx, accountId: string): Promise<boolean> {
  const row = await db
    .selectFrom("org_anonymous_accounts")
    .select("account_id")
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return row !== undefined;
}

/** 目标是匿名访客 → `409 member.anonymous_guest`。 */
export async function rejectAnonymousGuest(db: KernelDb | Trx, accountId: string): Promise<void> {
  if (await isAnonymousGuest(db, accountId)) {
    throw new ApiError(
      "member.anonymous_guest",
      "The anonymous guest of an organization cannot be given a role, ownership or agents, invited or removed",
    );
  }
}

/**
 * 成员服务。发起人只传账号 id，角色由服务在组织行锁内实时读取，调用方无法传入过期角色。所有写操作在事务内先 `SELECT … FROM orgs WHERE id = $1 FOR NO KEY UPDATE`，
 * 把同一组织的成员变更串行化（多副本下两个 owner 并发互相降级也恰好剩一个 owner）。
 * 框架无关，由调用方注入 db。
 */
export class MembersService {
  /** `offboarding`：移出与离开走的离职处理（内核用 `Kernel.identity.offboarding`）。 */
  constructor(
    private readonly db: KernelDb,
    private readonly offboarding: Offboarding,
  ) {}

  async list(orgId: string): Promise<Member[]> {
    const rows = await this.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .leftJoin("org_anonymous_accounts", (j) =>
        j
          .onRef("org_anonymous_accounts.org_id", "=", "memberships.org_id")
          .onRef("org_anonymous_accounts.account_id", "=", "memberships.account_id"),
      )
      .select([
        "accounts.id",
        "accounts.display_name",
        "accounts.email",
        "memberships.role",
        "memberships.created_at",
        "org_anonymous_accounts.account_id as anonymous_id",
      ])
      .where("memberships.org_id", "=", orgId)
      .orderBy("memberships.created_at")
      .orderBy("accounts.id")
      .execute();
    return rows.map((r) => ({
      account: { id: r.id, displayName: r.display_name, email: r.email },
      role: r.role,
      joinedAt: r.created_at,
      anonymous: r.anonymous_id !== null,
    }));
  }

  /**
   * 加入成员（邀请接受等，手动加入的唯一入口）；已是成员 → `member.already_exists`；匿名访客 → `member.anonymous_guest`。
   * 同一事务删除此人在该组织的通讯录排除（Ruling A20：手动重新加入后，通讯录同步恢复照常管理此人）。
   * `actorAccountId` 仅用于审计。
   */
  async add(
    orgId: string,
    accountId: string,
    role: OrgRole,
    actorAccountId: string,
    trx?: Trx,
  ): Promise<void> {
    const run = async (t: Trx): Promise<void> => {
      await lockOrg(t, orgId);
      await rejectAnonymousGuest(t, accountId);
      if (await this.roleIn(t, orgId, accountId)) {
        throw new ApiError("member.already_exists", "Account is already a member");
      }
      await t
        .insertInto("memberships")
        .values({ org_id: orgId, account_id: accountId, role })
        .execute();
      await t
        .deleteFrom("directory_exclusions")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
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
   * 发起人的角色在组织行锁内实时重读（spec 3.6 R5）：已不是成员或低于 admin → `forbidden`。
   * 目标是匿名访客 → `member.anonymous_guest`。
   */
  async changeRole(
    orgId: string,
    targetId: string,
    role: OrgRole,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      const { role: actorRole } = await lockOrgAndAuthorize(
        t,
        orgId,
        actorAccountId,
        "org.members.manage",
      );
      const before = await this.requireMember(t, orgId, targetId);
      await rejectAnonymousGuest(t, targetId);
      if ((role === "owner" || before === "owner") && actorRole !== "owner") {
        throw new ApiError("org.owner_required", "Only an owner can change owner roles");
      }
      if (before === role) return;
      await this.setRole(t, orgId, targetId, role);
      await this.assertHasOwner(t, orgId);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "org.member.role_changed",
        target: targetId,
        detail: { from: before, to: role },
      });
    });
  }

  /**
   * 移出成员：权限规则同 changeRole（移除 owner 须发起人是 owner）；移除最后一个 owner → `org.last_owner`。
   * 走离职处理（{@link Offboarding.offboard}，原因 `removed`），与之同一事务；提交后写吊销标记、发布事件。
   * 匿名访客不能移出（`member.anonymous_guest`；不再需要匿名访问时把渠道连接改回绑定策略）。
   */
  async remove(
    orgId: string,
    targetId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    const r = await this.db.transaction().execute(async (t) => {
      const { role: actorRole } = await lockOrgAndAuthorize(
        t,
        orgId,
        actorAccountId,
        "org.members.manage",
      );
      const before = await this.requireMember(t, orgId, targetId);
      await rejectAnonymousGuest(t, targetId);
      if (before === "owner" && actorRole !== "owner") {
        throw new ApiError("org.owner_required", "Only an owner can remove an owner");
      }
      const actor = { actorAccountId, ...(actorTokenId !== undefined && { actorTokenId }) };
      const res = await this.offboarding.offboard(t, orgId, targetId, "removed", actor);
      await audit(t, {
        ...actor,
        orgId,
        action: "org.member.removed",
        target: targetId,
        detail: { role: before },
      });
      return res;
    });
    await this.offboarding.afterCommit(r);
  }

  /** 主动离开：走离职处理（原因 `left`）；最后一个 owner → `org.last_owner`。 */
  async leave(orgId: string, accountId: string, actorTokenId?: string): Promise<void> {
    const r: OffboardResult = await this.db.transaction().execute(async (t) => {
      await lockOrg(t, orgId);
      const before = await this.requireMember(t, orgId, accountId);
      const actor = {
        actorAccountId: accountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
      };
      const res = await this.offboarding.offboard(t, orgId, accountId, "left", actor);
      await audit(t, {
        ...actor,
        orgId,
        action: "org.member.left",
        target: accountId,
        detail: { role: before },
      });
      return res;
    });
    await this.offboarding.afterCommit(r);
  }

  /**
   * 转让所有权：from 必须是 owner（`org.owner_required`）；to 必须是成员（`member.not_found`）且不是匿名访客
   * （`member.anonymous_guest`）；to → owner、from → admin。
   */
  async transferOwnership(
    orgId: string,
    fromAccountId: string,
    toAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    if (fromAccountId === toAccountId) {
      throw new ApiError("validation_failed", "Cannot transfer ownership to yourself");
    }
    await this.db.transaction().execute(async (t) => {
      await lockOrg(t, orgId);
      const fromRole = await this.roleIn(t, orgId, fromAccountId);
      if (fromRole !== "owner") {
        throw new ApiError("org.owner_required", "Only an owner can transfer ownership");
      }
      const toRole = await this.requireMember(t, orgId, toAccountId);
      await rejectAnonymousGuest(t, toAccountId);
      await this.setRole(t, orgId, toAccountId, "owner");
      await this.setRole(t, orgId, fromAccountId, "admin");
      await audit(t, {
        actorAccountId: fromAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
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
