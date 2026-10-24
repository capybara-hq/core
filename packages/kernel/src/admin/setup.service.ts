import type { Transaction } from "kysely";
import { sql } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { Account, AccountsService } from "../identity/accounts.js";
import { audit } from "../identity/audit.js";
import type { Org, OrgsService } from "../orgs/orgs.service.js";

const alreadyCompleted = () =>
  new ApiError("setup.already_completed", "Deployment is already set up");

/** 初始化向导与 CLI 建企业管理员。框架无关，由调用方注入依赖。 */
export class SetupService {
  constructor(
    private readonly db: KernelDb,
    private readonly accounts: AccountsService,
    private readonly orgs: OrgsService,
  ) {}

  /** 不存在活跃企业管理员即需要初始化（每次实时查 PG，不缓存）。 */
  async status(): Promise<{ needsSetup: boolean }> {
    return { needsSetup: (await this.accounts.countEnterpriseAdmins()) === 0 };
  }

  /**
   * 完成初始化：单个事务内先取咨询锁串行化并发的初始化请求，锁内再确认没有活跃企业管理员，
   * 然后建企业管理员账号、（给了 `orgName` 时）建组织并以其为 owner。任一步失败整体回滚。
   * 给了 `inTx` 时在同一事务的最后调用它（初始化向导用它建会话），结果放在 `extra`；它失败同样整体回滚。
   */
  async complete<T = undefined>(
    input: {
      login: string;
      password: string;
      displayName: string;
      orgName?: string | undefined;
    },
    inTx?: (trx: Transaction<KernelDatabase>, account: Account) => Promise<T>,
  ): Promise<{ account: Account; org?: Org; extra: T | undefined }> {
    // 先做一次廉价的预检查（已初始化的部署不白跑 scrypt），再在 BEGIN 之前算好哈希：
    // 不在持有咨询锁的事务里跑 scrypt；锁内仍会复核
    if ((await this.accounts.countEnterpriseAdmins()) > 0) throw alreadyCompleted();
    const passwordHash = await this.accounts.hashNewPassword(input.password);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('capybara.setup'))`.execute(trx);
      if ((await this.accounts.countEnterpriseAdmins(trx)) > 0) throw alreadyCompleted();
      const account = await this.accounts.createLocal(
        {
          login: input.login,
          password: input.password,
          displayName: input.displayName,
          enterpriseAdmin: true,
        },
        trx,
        passwordHash,
      );
      const org =
        input.orgName !== undefined
          ? await this.orgs.create({ name: input.orgName }, account, { trx })
          : undefined;
      await audit(trx, {
        actorAccountId: account.id,
        action: "deployment.setup_completed",
        target: account.id,
        ...(org && { orgId: org.id, detail: { orgId: org.id } }),
      });
      const extra = inTx ? await inTx(trx, account) : undefined;
      return { account, ...(org && { org }), extra };
    });
  }

  /** CLI 用：直接建企业管理员，不检查是否已初始化；登录名已存在 → `account.login_taken`。 */
  async createEnterpriseAdmin(input: EnterpriseAdminInput): Promise<Account> {
    const passwordHash = await this.accounts.hashNewPassword(input.password);
    return this.db
      .transaction()
      .execute((trx) => this.insertEnterpriseAdmin(trx, input, passwordHash));
  }

  /**
   * CLI `admin create --if-none`: create an enterprise admin only when no active one exists. The
   * check and the insert run in one transaction under the same advisory lock as {@link complete},
   * so concurrent runs (and a concurrent web setup) create exactly one. Returns undefined when an
   * active enterprise admin already exists; a taken login still throws `account.login_taken`.
   */
  async createEnterpriseAdminIfNone(input: EnterpriseAdminInput): Promise<Account | undefined> {
    const passwordHash = await this.accounts.hashNewPassword(input.password);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('capybara.setup'))`.execute(trx);
      if ((await this.accounts.countEnterpriseAdmins(trx)) > 0) return undefined;
      return this.insertEnterpriseAdmin(trx, input, passwordHash);
    });
  }

  private async insertEnterpriseAdmin(
    trx: Transaction<KernelDatabase>,
    input: EnterpriseAdminInput,
    passwordHash: string,
  ): Promise<Account> {
    const account = await this.accounts.createLocal(
      {
        login: input.login,
        password: input.password,
        displayName: input.displayName,
        enterpriseAdmin: true,
        ...(input.email !== undefined && { email: input.email }),
      },
      trx,
      passwordHash,
    );
    await audit(trx, {
      action: "account.created",
      target: account.id,
      detail: { enterpriseAdmin: true, via: "cli" },
    });
    return account;
  }
}

/** Input of the CLI enterprise admin creation. */
export interface EnterpriseAdminInput {
  login: string;
  password: string;
  displayName: string;
  email?: string | undefined;
}
