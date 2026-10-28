import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql, type Updateable } from "kysely";
import { SetupLock } from "../admin/setup-lock.js";
import type { AccountsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { audit } from "./audit.js";
import { EnterpriseAdminLock } from "./enterprise-admin.js";
import { MAX_PASSWORD_LENGTH, normalizeLogin, validatePassword } from "./login.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./passwords.js";

export interface Account {
  id: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  isEnterpriseAdmin: boolean;
  createdAt: Date;
}

/** 企业管理员可改的账号字段。 */
export type AccountPatch = {
  displayName?: string;
  status?: "active" | "disabled";
  isEnterpriseAdmin?: boolean;
};

/** 构造 `Account` 所需的 accounts 列（供跨表查询 select 使用）。 */
export const ACCOUNT_COLUMNS = [
  "accounts.id",
  "accounts.display_name",
  "accounts.email",
  "accounts.status",
  "accounts.is_enterprise_admin",
  "accounts.created_at",
] as const;

type AccountRow = Pick<
  Selectable<AccountsTable>,
  "id" | "display_name" | "email" | "status" | "is_enterprise_admin" | "created_at"
>;

export function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    status: r.status,
    isEnterpriseAdmin: r.is_enterprise_admin,
    createdAt: r.created_at,
  };
}

/** 仅当违反 identities 主键约束（登录名已被占用）时为 true；其他唯一约束冲突照常抛出。 */
function isLoginTaken(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string };
  return err.code === "23505" && err.constraint === "identities_pkey";
}

export interface LocalAccountInput {
  login: string;
  password: string;
  displayName: string;
  email?: string;
  enterpriseAdmin?: boolean;
}

interface PreparedLocal {
  input: LocalAccountInput;
  login: string;
  passwordHash: string;
}

/**
 * 规范化登录名、校验并哈希密码（不碰数据库，可在事务 / 锁之外先做）。
 * 给了 `passwordHash`（调用方已在事务外算好）时不再跑 scrypt。
 */
async function prepareLocal(
  input: LocalAccountInput,
  passwordHash?: string,
): Promise<PreparedLocal> {
  const login = normalizeLogin(input.login);
  validatePassword(input.password);
  return { input, login, passwordHash: passwordHash ?? (await hashPassword(input.password)) };
}

/**
 * Accounts: local account creation, authentication and administration. Every write is
 * `@Transactional` (joining the caller's transaction when there is one); scrypt runs before any
 * transaction opens.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(SetupLock) private readonly setupLock: SetupLock,
  ) {}

  /** Checks the password length and hashes it (scrypt, slow): for callers that hash before their transaction opens. */
  async hashNewPassword(password: string): Promise<string> {
    validatePassword(password);
    return hashPassword(password);
  }

  /**
   * Creates a local account, in the caller's transaction when there is one. A caller inside a
   * transaction hashes first with {@link hashNewPassword} and passes `passwordHash`, so the
   * connection is never idle in transaction during scrypt.
   */
  async createLocal(input: LocalAccountInput, passwordHash?: string): Promise<Account> {
    return this.insertLocal(await prepareLocal(input, passwordHash));
  }

  /**
   * An enterprise admin creates a local account (optionally an enterprise admin): under the
   * enterprise admin lock, re-checks that the actor is still an active enterprise admin (else
   * `forbidden`), creates the account and audits `account.created`. The hash is computed before
   * the lock.
   */
  async createByAdmin(
    input: LocalAccountInput,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<Account> {
    return this.createByAdminIn(await prepareLocal(input), actorAccountId, actorTokenId);
  }

  @Transactional()
  private async createByAdminIn(
    prepared: PreparedLocal,
    actorAccountId: string,
    actorTokenId: string | undefined,
  ): Promise<Account> {
    await this.adminLock.lockAndAuthorize(actorAccountId);
    const a = await this.insertLocal(prepared);
    await audit(this.db.db, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      action: "account.created",
      target: a.id,
      detail: { enterpriseAdmin: a.isEnterpriseAdmin },
    });
    return a;
  }

  /**
   * CLI: creates an enterprise admin without checking whether the deployment is set up; a taken
   * login → `account.login_taken`.
   */
  async createEnterpriseAdmin(input: EnterpriseAdminInput): Promise<Account> {
    return this.insertEnterpriseAdmin(input, await this.hashNewPassword(input.password));
  }

  /**
   * CLI `admin create --if-none`: creates an enterprise admin only when no active one exists. The
   * check and the insert run in one transaction under {@link SetupLock}, the lock the web setup
   * takes, so concurrent runs (and a concurrent web setup) create exactly one. Returns undefined
   * when an active enterprise admin already exists; a taken login still throws
   * `account.login_taken`.
   */
  async createEnterpriseAdminIfNone(input: EnterpriseAdminInput): Promise<Account | undefined> {
    return this.createEnterpriseAdminIfNoneIn(input, await this.hashNewPassword(input.password));
  }

  @Transactional()
  private async createEnterpriseAdminIfNoneIn(
    input: EnterpriseAdminInput,
    passwordHash: string,
  ): Promise<Account | undefined> {
    await this.setupLock.lock();
    if ((await this.countEnterpriseAdmins()) > 0) return undefined;
    return this.insertEnterpriseAdmin(input, passwordHash);
  }

  @Transactional()
  private async insertEnterpriseAdmin(
    input: EnterpriseAdminInput,
    passwordHash: string,
  ): Promise<Account> {
    const account = await this.createLocal(
      {
        login: input.login,
        password: input.password,
        displayName: input.displayName,
        enterpriseAdmin: true,
        ...(input.email !== undefined && { email: input.email }),
      },
      passwordHash,
    );
    await audit(this.db.db, {
      action: "account.created",
      target: account.id,
      detail: { enterpriseAdmin: true, via: "cli" },
    });
    return account;
  }

  async authenticateLocal(login: string, password: string): Promise<Account | null> {
    // 超长密码不可能正确（validatePassword 上限 256），不跑 scrypt 也不查库，免得被超长输入拖慢；
    // 只暴露「密码超长」这一事实，正常长度密码下未知登录名与错密码的耗时仍相当
    if (password.length > MAX_PASSWORD_LENGTH) return null;
    let external: string;
    try {
      external = normalizeLogin(login);
    } catch {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      return null;
    }
    const row = await this.db
      .selectFrom("identities")
      .innerJoin("accounts", "accounts.id", "identities.account_id")
      .innerJoin("local_passwords", "local_passwords.account_id", "accounts.id")
      .select([
        "accounts.id",
        "accounts.display_name",
        "accounts.email",
        "accounts.email_verified",
        "accounts.status",
        "accounts.is_enterprise_admin",
        "accounts.created_at",
        "accounts.updated_at",
        "local_passwords.password_hash",
      ])
      .where("identities.source", "=", "local")
      .where("identities.external_id", "=", external)
      .executeTakeFirst();
    if (!row) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      return null;
    }
    if (!(await verifyPassword(row.password_hash, password))) return null;
    if (row.status === "disabled") {
      throw new ApiError("auth.account_disabled", "Account is disabled");
    }
    return toAccount(row);
  }

  /** 按账号 id 校验本地密码（改密码时核对旧密码）；没有本地密码、超长或不符 → false。 */
  async verifyPassword(accountId: string, password: string): Promise<boolean> {
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    const row = await this.db
      .selectFrom("local_passwords")
      .select("password_hash")
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return verifyPassword(row?.password_hash ?? DUMMY_PASSWORD_HASH, password);
  }

  async get(id: string): Promise<Account | undefined> {
    const row = await this.db
      .selectFrom("accounts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row && toAccount(row);
  }

  /** 按 id 升序分页，`after` 为上一页最后一个 id。 */
  async list(opts: { limit: number; after?: string }): Promise<Account[]> {
    let q = this.db.selectFrom("accounts").selectAll().orderBy("id").limit(opts.limit);
    if (opts.after !== undefined) q = q.where("id", ">", opts.after);
    return (await q.execute()).map(toAccount);
  }

  async setPassword(accountId: string, password: string): Promise<void> {
    validatePassword(password);
    await this.writePassword(accountId, await hashPassword(password));
  }

  /**
   * A person changes their password (R24): one PG transaction writes the new password and revokes
   * the account's sessions except `exceptSessionId` (`sessions.revoked_at`) and all its personal
   * access tokens; all or nothing. scrypt runs before BEGIN. Returns the revoked session ids; the
   * caller then writes the Redis revocation markers (the fast path: auth reads PG `revoked_at`,
   * so a failed marker never keeps a session usable).
   */
  async changePassword(
    accountId: string,
    password: string,
    exceptSessionId: string,
  ): Promise<string[]> {
    return this.changePasswordIn(accountId, await this.hashNewPassword(password), exceptSessionId);
  }

  @Transactional()
  private async changePasswordIn(
    accountId: string,
    passwordHash: string,
    exceptSessionId: string,
  ): Promise<string[]> {
    await this.writePassword(accountId, passwordHash);
    const sessions = await this.db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .where("id", "!=", exceptSessionId)
      .returning("id")
      .execute();
    await this.db
      .updateTable("api_tokens")
      .set({ revoked_at: sql<Date>`now()` })
      .where("kind", "=", "personal")
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .execute();
    return sessions.map((r) => r.id);
  }

  async update(
    id: string,
    patch: AccountPatch,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<Account> {
    return (await this.updateAccount(id, patch, actorAccountId, actorTokenId)).account;
  }

  /**
   * An enterprise admin changes an account. Disabling (`status: "disabled"`) revokes the
   * account's sessions (`sessions.revoked_at`) and personal tokens in **the same PG transaction**,
   * all or nothing; returns the revoked session ids, whose Redis markers the caller writes after
   * the commit (the fast path; a failure is only a warning: auth reads PG).
   */
  @Transactional()
  async updateAccount(
    id: string,
    patch: AccountPatch,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<{ account: Account; revokedSessionIds: string[] }> {
    // Every enterprise admin write is serialized by one lock and re-checks the actor under it: two
    // admins revoking each other concurrently cannot leave none, and a just-revoked admin's
    // request in flight fails
    await this.adminLock.lockAndAuthorize(actorAccountId);
    const before = await this.db
      .selectFrom("accounts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!before) throw new ApiError("account.not_found", "Account not found");
    return this.applyUpdate(before, patch, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      detail: patch,
    });
  }

  /**
   * The CLI's `capybara admin grant|revoke <login>` (no actor account): changes the enterprise
   * admin flag by local login under the enterprise admin lock; revoking keeps the
   * {@link updateAccount} "last active enterprise admin" check (`account.last_enterprise_admin`),
   * decided under the lock, so it cannot race a web revoke into none. Audit `account.updated`
   * without an actor, `detail.via = "cli"`. Already in the target state → no change and no audit
   * (`changed: false`). Unknown login → `account.not_found`.
   */
  async setEnterpriseAdminByLogin(
    login: string,
    isEnterpriseAdmin: boolean,
  ): Promise<{ account: Account; changed: boolean }> {
    let external: string;
    try {
      external = normalizeLogin(login);
    } catch {
      throw new ApiError("account.not_found", "Account not found");
    }
    return this.setEnterpriseAdminIn(external, isEnterpriseAdmin);
  }

  @Transactional()
  private async setEnterpriseAdminIn(
    external: string,
    isEnterpriseAdmin: boolean,
  ): Promise<{ account: Account; changed: boolean }> {
    await this.adminLock.lock();
    const before = await this.db
      .selectFrom("identities")
      .innerJoin("accounts", "accounts.id", "identities.account_id")
      .selectAll("accounts")
      .where("identities.source", "=", "local")
      .where("identities.external_id", "=", external)
      .executeTakeFirst();
    if (!before) throw new ApiError("account.not_found", "Account not found");
    if (before.is_enterprise_admin === isEnterpriseAdmin) {
      return { account: toAccount(before), changed: false };
    }
    const patch = { isEnterpriseAdmin };
    const { account } = await this.applyUpdate(before, patch, {
      detail: { ...patch, via: "cli" },
    });
    return { account, changed: true };
  }

  /** 全部账号数（含停用的；后台概览）。 */
  async count(): Promise<number> {
    const r = await this.db
      .selectFrom("accounts")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** Active (status = active) enterprise admins, in the context's transaction when there is one. */
  async countEnterpriseAdmins(): Promise<number> {
    const r = await this.db
      .selectFrom("accounts")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("is_enterprise_admin", "=", true)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** Inserts the account, its local identity and password; a taken login → `account.login_taken`. */
  @Transactional()
  private async insertLocal(p: PreparedLocal): Promise<Account> {
    const { input, login, passwordHash } = p;
    const id = randomUUID();
    const row = await this.db
      .insertInto("accounts")
      .values({
        id,
        display_name: input.displayName,
        email: input.email ?? null,
        is_enterprise_admin: input.enterpriseAdmin ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    try {
      await this.db
        .insertInto("identities")
        .values({
          source: "local",
          external_id: login,
          account_id: id,
          email: input.email ?? null,
          linked_via: "local",
        })
        .execute();
    } catch (e) {
      if (isLoginTaken(e)) {
        throw new ApiError("account.login_taken", "Login is already taken");
      }
      throw e;
    }
    await this.db
      .insertInto("local_passwords")
      .values({ account_id: id, password_hash: passwordHash })
      .execute();
    return toAccount(row);
  }

  /** Writes (or replaces) the local password hash; a missing account → `account.not_found`. */
  @Transactional()
  private async writePassword(accountId: string, passwordHash: string): Promise<void> {
    const exists = await this.db
      .selectFrom("accounts")
      .select("id")
      .where("id", "=", accountId)
      .executeTakeFirst();
    if (!exists) throw new ApiError("account.not_found", "Account not found");
    await this.db
      .insertInto("local_passwords")
      .values({ account_id: accountId, password_hash: passwordHash })
      .onConflict((oc) =>
        oc
          .column("account_id")
          .doUpdateSet({ password_hash: passwordHash, updated_at: new Date() }),
      )
      .execute();
  }

  /**
   * Changes the account under the enterprise admin lock the caller holds: updates the row,
   * re-checks "the last active enterprise admin", audits `account.updated`; disabling revokes the
   * account's sessions and personal tokens.
   */
  @Transactional({ propagation: "mandatory" })
  private async applyUpdate(
    before: Selectable<AccountsTable>,
    patch: AccountPatch,
    auditAs: { actorAccountId?: string; actorTokenId?: string; detail: Record<string, unknown> },
  ): Promise<{ account: Account; revokedSessionIds: string[] }> {
    const id = before.id;
    const values: Updateable<AccountsTable> = { updated_at: new Date() };
    if (patch.displayName !== undefined) values.display_name = patch.displayName;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.isEnterpriseAdmin !== undefined) values.is_enterprise_admin = patch.isEnterpriseAdmin;
    const row = await this.db
      .updateTable("accounts")
      .set(values)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const wasActiveAdmin = before.is_enterprise_admin && before.status === "active";
    const isActiveAdmin = row.is_enterprise_admin && row.status === "active";
    if (wasActiveAdmin && !isActiveAdmin && (await this.countEnterpriseAdmins()) === 0) {
      throw new ApiError(
        "account.last_enterprise_admin",
        "Cannot remove the last active enterprise admin",
      );
    }
    await audit(this.db.db, {
      ...(auditAs.actorAccountId !== undefined && { actorAccountId: auditAs.actorAccountId }),
      ...(auditAs.actorTokenId !== undefined && { actorTokenId: auditAs.actorTokenId }),
      action: "account.updated",
      target: id,
      detail: auditAs.detail,
    });
    let revokedSessionIds: string[] = [];
    if (patch.status === "disabled") {
      // Auth reads the account status on every request, so disabling is effective at once; the
      // credentials are revoked too, so re-enabling does not bring old ones back
      const sessions = await this.db
        .updateTable("sessions")
        .set({ revoked_at: sql<Date>`now()` })
        .where("account_id", "=", id)
        .where("revoked_at", "is", null)
        .returning("id")
        .execute();
      await this.db
        .updateTable("api_tokens")
        .set({ revoked_at: sql<Date>`now()` })
        .where("kind", "=", "personal")
        .where("account_id", "=", id)
        .where("revoked_at", "is", null)
        .execute();
      revokedSessionIds = sessions.map((r) => r.id);
    }
    return { account: toAccount(row), revokedSessionIds };
  }
}

/** Input of the CLI enterprise admin creation. */
export interface EnterpriseAdminInput {
  login: string;
  password: string;
  displayName: string;
  email?: string | undefined;
}
