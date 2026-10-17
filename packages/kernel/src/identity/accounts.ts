import { randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type { AccountsTable, KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "./enterprise-admin.js";
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

type Trx = Transaction<KernelDatabase>;

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

/** 在事务内插入账号、本地身份与密码；登录名已占用 → `account.login_taken`。 */
async function insertLocal(t: Trx, p: PreparedLocal): Promise<Account> {
  const { input, login, passwordHash } = p;
  const id = randomUUID();
  const row = await t
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
    await t
      .insertInto("identities")
      .values({
        source: "local",
        external_id: login,
        account_id: id,
        email: input.email ?? null,
      })
      .execute();
  } catch (e) {
    if (isLoginTaken(e)) {
      throw new ApiError("account.login_taken", "Login is already taken");
    }
    throw e;
  }
  await t
    .insertInto("local_passwords")
    .values({ account_id: id, password_hash: passwordHash })
    .execute();
  return toAccount(row);
}

/** 在事务内写入（或覆盖）本地密码哈希；账号不存在 → `account.not_found`。 */
async function writePassword(t: Trx, accountId: string, passwordHash: string): Promise<void> {
  const exists = await t
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", accountId)
    .executeTakeFirst();
  if (!exists) throw new ApiError("account.not_found", "Account not found");
  await t
    .insertInto("local_passwords")
    .values({ account_id: accountId, password_hash: passwordHash })
    .onConflict((oc) =>
      oc.column("account_id").doUpdateSet({ password_hash: passwordHash, updated_at: new Date() }),
    )
    .execute();
}

/** 账号服务：本地账号的创建、认证与管理。框架无关，由调用方注入 db。 */
export class AccountsService {
  constructor(private readonly db: KernelDb) {}

  /** 校验密码长度并算出哈希（scrypt，较慢）：供需要在事务之外先算好哈希的调用方使用。 */
  async hashNewPassword(password: string): Promise<string> {
    validatePassword(password);
    return hashPassword(password);
  }

  /**
   * 建本地账号。传 `trx` 时在调用方的事务内插入；在事务内调用时应先在事务**之外**用 `hashNewPassword`
   * 算好 `passwordHash` 传进来，避免 scrypt 期间连接处于 idle in transaction。
   */
  async createLocal(input: LocalAccountInput, trx?: Trx, passwordHash?: string): Promise<Account> {
    const prepared = await prepareLocal(input, passwordHash);
    const run = (t: Trx) => insertLocal(t, prepared);
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  /**
   * 企业管理员建本地账号（可同时设为企业管理员）：事务内取企业管理员锁并复核发起人仍是活跃企业管理员
   * （否则 `forbidden`），建号并写审计 `account.created`。密码哈希在取锁之前算好，不在锁内跑 scrypt。
   */
  async createByAdmin(
    input: LocalAccountInput,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<Account> {
    const prepared = await prepareLocal(input);
    return this.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actorAccountId);
      const a = await insertLocal(trx, prepared);
      await audit(trx, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        action: "account.created",
        target: a.id,
        detail: { enterpriseAdmin: a.isEnterpriseAdmin },
      });
      return a;
    });
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
    const passwordHash = await hashPassword(password);
    await this.db.transaction().execute((trx) => writePassword(trx, accountId, passwordHash));
  }

  /**
   * 用户改密码（R24）：同一个 PG 事务里写新密码、吊销该账号除 `exceptSessionId` 外的全部会话
   * （`sessions.revoked_at`）与全部个人访问令牌，要么全部生效要么都不生效。scrypt 在 BEGIN 之前算好。
   * 返回被吊销的会话 id，调用方随后写 Redis 吊销标记（快速路径；鉴权以 PG `revoked_at` 为准，
   * 标记写失败也不会让这些会话继续可用）。
   */
  async changePassword(
    accountId: string,
    password: string,
    exceptSessionId: string,
  ): Promise<string[]> {
    const passwordHash = await this.hashNewPassword(password);
    return this.db.transaction().execute(async (trx) => {
      await writePassword(trx, accountId, passwordHash);
      const sessions = await trx
        .updateTable("sessions")
        .set({ revoked_at: sql<Date>`now()` })
        .where("account_id", "=", accountId)
        .where("revoked_at", "is", null)
        .where("id", "!=", exceptSessionId)
        .returning("id")
        .execute();
      await trx
        .updateTable("api_tokens")
        .set({ revoked_at: sql<Date>`now()` })
        .where("kind", "=", "personal")
        .where("account_id", "=", accountId)
        .where("revoked_at", "is", null)
        .execute();
      return sessions.map((r) => r.id);
    });
  }

  async update(
    id: string,
    patch: {
      displayName?: string;
      status?: "active" | "disabled";
      isEnterpriseAdmin?: boolean;
    },
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<Account> {
    return this.db.transaction().execute(async (trx) => {
      // 所有企业管理员写操作在同一把锁下串行，并在锁内复核发起人仍是活跃企业管理员：
      // 既避免两个管理员并发互相撤销后一个都不剩，也让刚被撤销的管理员的在途请求失效
      await lockEnterpriseAdminsAndAuthorize(trx, actorAccountId);
      const before = await trx
        .selectFrom("accounts")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!before) throw new ApiError("account.not_found", "Account not found");
      const values: Partial<Record<"display_name" | "status" | "is_enterprise_admin", unknown>> =
        {};
      if (patch.displayName !== undefined) values.display_name = patch.displayName;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.isEnterpriseAdmin !== undefined)
        values.is_enterprise_admin = patch.isEnterpriseAdmin;
      const row = await trx
        .updateTable("accounts")
        .set({ ...(values as object), updated_at: new Date() })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const wasActiveAdmin = before.is_enterprise_admin && before.status === "active";
      const isActiveAdmin = row.is_enterprise_admin && row.status === "active";
      if (wasActiveAdmin && !isActiveAdmin && (await this.countEnterpriseAdmins(trx)) === 0) {
        throw new ApiError(
          "account.last_enterprise_admin",
          "Cannot remove the last active enterprise admin",
        );
      }
      await audit(trx, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        action: "account.updated",
        target: id,
        detail: patch,
      });
      return toAccount(row);
    });
  }

  /** 活跃（status = active）的企业管理员数量。 */
  async countEnterpriseAdmins(trx?: Trx): Promise<number> {
    const r = await (trx ?? this.db)
      .selectFrom("accounts")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("is_enterprise_admin", "=", true)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }
}
