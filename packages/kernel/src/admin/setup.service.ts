import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";
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
   */
  async complete(input: {
    login: string;
    password: string;
    displayName: string;
    orgName?: string | undefined;
  }): Promise<{ account: Account; org?: Org }> {
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
      return { account, ...(org && { org }) };
    });
  }

  /** CLI 用：直接建企业管理员，不检查是否已初始化；登录名已存在 → `account.login_taken`。 */
  async createEnterpriseAdmin(input: {
    login: string;
    password: string;
    displayName: string;
    email?: string | undefined;
  }): Promise<Account> {
    const passwordHash = await this.accounts.hashNewPassword(input.password);
    return this.db.transaction().execute(async (trx) => {
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
    });
  }
}
