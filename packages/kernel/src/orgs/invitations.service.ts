import { randomBytes, randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type { InvitationsTable, KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { Account, AccountsService } from "../identity/accounts.js";
import { audit } from "../identity/audit.js";
import { sha256Hex } from "../identity/hash.js";
import type { MembersService } from "./members.service.js";
import { lockOrgAndAuthorize, tryLockOrg } from "./org-lock.js";
import { type OrgRole, roleAtLeast } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

/** 可邀请的角色（owner 只能经转让获得）。 */
export const INVITABLE_ROLES = ["admin", "member", "guest"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const DEFAULT_INVITATION_HOURS = 168;
export const MAX_INVITATION_HOURS = 720;

const TOKEN_PREFIX = "cap_inv_";

export type Invitation = {
  id: string;
  orgId: string;
  role: InvitableRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export type AcceptAs =
  | { accountId: string }
  | { signup: { login: string; password: string; displayName: string } };

function toInvitation(r: Selectable<InvitationsTable>): Invitation {
  return {
    id: r.id,
    orgId: r.org_id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    revokedAt: r.revoked_at,
  };
}

const invalid = () => new ApiError("invitation.invalid", "Invitation is invalid");
const forbidden = () => new ApiError("forbidden", "Insufficient organization role");

/**
 * 组织邀请。令牌 `cap_inv_` + 32 字节 base64url，库里只存 SHA-256（按 hash 在 SQL 里查找）。
 * 写操作（create / revoke）与成员服务一样先锁组织行，并在锁内实时重读发起人角色（只接收账号 id，不接收角色）。
 * 加锁顺序统一为「组织行 → 邀请行」，accept 也先锁组织行，避免与 revoke 死锁。框架无关，由调用方注入依赖。
 */
export class InvitationsService {
  constructor(
    private readonly db: KernelSchemaDb,
    private readonly accounts: AccountsService,
    private readonly members: MembersService,
  ) {}

  async create(
    orgId: string,
    input: { role: InvitableRole; expiresInHours?: number | undefined },
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<{ invitation: Invitation; token: string }> {
    if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) {
      throw new ApiError("validation_failed", "Role cannot be invited");
    }
    const hours = input.expiresInHours ?? DEFAULT_INVITATION_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_INVITATION_HOURS) {
      throw new ApiError(
        "validation_failed",
        `expiresInHours must be an integer between 1 and ${MAX_INVITATION_HOURS}`,
      );
    }
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    return this.db.transaction().execute(async (t) => {
      const { role: actorRole } = await lockOrgAndAuthorize(
        t,
        orgId,
        actorAccountId,
        "org.invitations.manage",
      );
      if (!roleAtLeast(actorRole, input.role)) throw forbidden();
      const row = await t
        .insertInto("invitations")
        .values({
          id: randomUUID(),
          org_id: orgId,
          role: input.role,
          token_hash: sha256Hex(token),
          created_by: actorAccountId,
          expires_at: sql<Date>`now() + make_interval(hours => ${hours})`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "org.invitation.created",
        target: row.id,
        detail: { role: input.role, expiresAt: row.expires_at.toISOString() },
      });
      return { invitation: toInvitation(row), token };
    });
  }

  async list(orgId: string): Promise<(Invitation & { status: InvitationStatus })[]> {
    const rows = await this.db
      .selectFrom("invitations")
      .selectAll()
      .select(sql<boolean>`expires_at <= now()`.as("expired"))
      .where("org_id", "=", orgId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(({ expired, ...r }) => {
      const status: InvitationStatus = r.revoked_at
        ? "revoked"
        : r.accepted_at
          ? "accepted"
          : expired
            ? "expired"
            : "pending";
      return { ...toInvitation(r), status };
    });
  }

  /** 撤销；不属于该组织 → `invitation.invalid`；已接受 → `invitation.used`；已撤销则无操作。 */
  async revoke(
    orgId: string,
    id: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "org.invitations.manage");
      const row = await t
        .selectFrom("invitations")
        .selectAll()
        .where("id", "=", id)
        .where("org_id", "=", orgId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw invalid();
      if (row.accepted_at) throw new ApiError("invitation.used", "Invitation was already used");
      if (row.revoked_at) return;
      await t
        .updateTable("invitations")
        .set({ revoked_at: sql<Date>`now()` })
        .where("id", "=", id)
        .execute();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "org.invitation.revoked",
        target: id,
        detail: { role: row.role },
      });
    });
  }

  async preview(
    token: string,
  ): Promise<{ org: { id: string; name: string }; role: InvitableRole; expiresAt: Date }> {
    const r = await this.classify(this.db, token);
    return { org: { id: r.org_id, name: r.org_name }, role: r.role, expiresAt: r.expires_at };
  }

  /**
   * 接受邀请，单个事务：按 hash 读邀请并分类错误 →（signup 时建账号）→ 锁组织行
   * → 条件 UPDATE 占用邀请（0 行则重新分类，并发的后到者得到 `invitation.used`）→ 加入成员（`members.add` 检查已是成员 → `member.already_exists`，整体回滚含邀请占用）。任何一步失败整体回滚。
   * signup 时先在事务外分类一次（无效令牌不白跑 scrypt），再在 BEGIN 之前算好密码哈希，
   * 事务内只有读写，连接不会在 scrypt 期间处于 idle in transaction。
   */
  async accept<T = undefined>(
    token: string,
    who: AcceptAs,
    inTx?: (t: Trx, account: Account) => Promise<T>,
  ): Promise<{ account: Account; orgId: string; role: OrgRole; extra: T | undefined }> {
    let existing: Account | undefined;
    let passwordHash: string | undefined;
    if ("accountId" in who) {
      existing = await this.accounts.get(who.accountId);
      if (!existing) throw new ApiError("account.not_found", "Account not found");
    } else {
      await this.classify(this.db, token);
      passwordHash = await this.accounts.hashNewPassword(who.signup.password);
    }
    return this.db.transaction().execute(async (t) => {
      const inv = await this.classify(t, token);
      // 先建账号再锁组织行，缩短持锁时间；失败时随事务回滚，不残留账号
      const account = existing ?? (await this.accounts.createLocal(signupOf(who), t, passwordHash));
      if (!(await tryLockOrg(t, inv.org_id))) throw invalid();
      const taken = await t
        .updateTable("invitations")
        .set({ accepted_at: sql<Date>`now()`, accepted_by: account.id })
        .where("id", "=", inv.id)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .where(sql<boolean>`expires_at > now()`)
        .returning("id")
        .executeTakeFirst();
      if (!taken) {
        await this.classify(t, token);
        throw new ApiError("invitation.used", "Invitation was already used");
      }
      await this.members.add(inv.org_id, account.id, inv.role, account.id, t);
      await audit(t, {
        actorAccountId: account.id,
        orgId: inv.org_id,
        action: "org.invitation.accepted",
        target: inv.id,
        detail: { role: inv.role, signup: "signup" in who },
      });
      // 凭邀请注册时在同一事务里建会话：失败整体回滚，不残留没有会话的新账号
      const extra = inTx ? await inTx(t, account) : undefined;
      return { account, orgId: inv.org_id, role: inv.role, extra };
    });
  }

  /**
   * 按令牌 hash 读邀请并分类：不存在、已撤销或组织已软删除 → `invitation.invalid`；
   * 已接受 → `invitation.used`；已过期 → `invitation.expired`。过期按数据库时间判定。
   */
  private async classify(db: KernelSchemaDb | Trx, token: string) {
    const r = await db
      .selectFrom("invitations")
      .innerJoin("orgs", "orgs.id", "invitations.org_id")
      .select([
        "invitations.id",
        "invitations.org_id",
        "invitations.role",
        "invitations.expires_at",
        "invitations.accepted_at",
        "invitations.revoked_at",
        "orgs.name as org_name",
        "orgs.deleted_at as org_deleted_at",
      ])
      .select(sql<boolean>`invitations.expires_at <= now()`.as("expired"))
      .where("invitations.token_hash", "=", sha256Hex(token))
      .executeTakeFirst();
    if (!r || r.revoked_at || r.org_deleted_at) throw invalid();
    if (r.accepted_at) throw new ApiError("invitation.used", "Invitation was already used");
    if (r.expired) throw new ApiError("invitation.expired", "Invitation has expired");
    return r;
  }
}

function signupOf(who: AcceptAs): { login: string; password: string; displayName: string } {
  if (!("signup" in who)) throw new Error("unreachable");
  return who.signup;
}
