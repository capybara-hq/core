import { randomUUID } from "node:crypto";
import { type Selectable, sql, type Transaction } from "kysely";
import type { AccountsTable, KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";
import { normalizeLogin, validatePassword } from "./login.js";
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

function toAccount(r: Selectable<AccountsTable>): Account {
  return {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    status: r.status,
    isEnterpriseAdmin: r.is_enterprise_admin,
    createdAt: r.created_at,
  };
}

/** 仅当违反 identities 主键（登录名已被占用）时为 true。 */
function isLoginTaken(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string; table?: string };
  return (
    err.code === "23505" && (err.constraint === "identities_pkey" || err.table === "identities")
  );
}

/** 账号服务：本地账号的创建、认证与管理。框架无关，由调用方注入 db。 */
export class AccountsService {
  constructor(private readonly db: KernelDb) {}

  async createLocal(
    input: {
      login: string;
      password: string;
      displayName: string;
      email?: string;
      enterpriseAdmin?: boolean;
    },
    trx?: Trx,
  ): Promise<Account> {
    const login = normalizeLogin(input.login);
    validatePassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const run = async (t: Trx): Promise<Account> => {
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
    };
    return trx ? run(trx) : this.db.transaction().execute(run);
  }

  async authenticateLocal(login: string, password: string): Promise<Account | null> {
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
    await this.db.transaction().execute(async (trx) => {
      const exists = await trx
        .selectFrom("accounts")
        .select("id")
        .where("id", "=", accountId)
        .executeTakeFirst();
      if (!exists) throw new ApiError("account.not_found", "Account not found");
      await trx
        .insertInto("local_passwords")
        .values({ account_id: accountId, password_hash: passwordHash })
        .onConflict((oc) =>
          oc
            .column("account_id")
            .doUpdateSet({ password_hash: passwordHash, updated_at: new Date() }),
        )
        .execute();
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
  ): Promise<Account> {
    return this.db.transaction().execute(async (trx) => {
      const losesAdmin = patch.isEnterpriseAdmin === false || patch.status === "disabled";
      // 撤销管理员或停用账号前先串行化，避免两个管理员并发互相撤销后一个都不剩
      if (losesAdmin) {
        await sql`SELECT pg_advisory_xact_lock(hashtext('capybara.enterprise_admins'))`.execute(
          trx,
        );
      }
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
