import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { type Account, AccountsService } from "../identity/accounts.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { type Org, OrgsService } from "../orgs/orgs.service.js";
import { SetupLock } from "./setup-lock.js";

const alreadyCompleted = () =>
  new ApiError("setup.already_completed", "Deployment is already set up");

/**
 * The setup wizard. The CLI's enterprise admin creation (`createEnterpriseAdmin`,
 * `createEnterpriseAdminIfNone`) is on `AccountsService`, under the same {@link SetupLock}.
 */
@Injectable()
export class SetupService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SetupLock) private readonly setupLock: SetupLock,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(OrgsService) private readonly orgs: OrgsService,
  ) {}

  /** 不存在活跃企业管理员即需要初始化（每次实时查 PG，不缓存）。 */
  async status(): Promise<{ needsSetup: boolean }> {
    return { needsSetup: (await this.accounts.countEnterpriseAdmins()) === 0 };
  }

  /**
   * Completes the setup in one transaction: {@link SetupLock} serializes concurrent setups, and
   * under it there must still be no active enterprise admin; then creates the enterprise admin
   * and (with `orgName`) an org it owns. Any failure rolls everything back. `inTx` runs last in the
   * same transaction (the wizard creates the session there), its result is `extra`; its failure
   * rolls back too.
   */
  async complete<T = undefined>(
    input: {
      login: string;
      password: string;
      displayName: string;
      orgName?: string | undefined;
    },
    inTx?: (account: Account) => Promise<T>,
  ): Promise<{ account: Account; org?: Org; extra: T | undefined }> {
    // A cheap pre-check first (a set-up deployment does not run scrypt for nothing), then the hash
    // before BEGIN: no scrypt inside the transaction holding the lock; the check runs again under it
    if ((await this.accounts.countEnterpriseAdmins()) > 0) throw alreadyCompleted();
    const passwordHash = await this.accounts.hashNewPassword(input.password);
    return this.completeIn(input, passwordHash, inTx);
  }

  @Transactional()
  private async completeIn<T>(
    input: { login: string; password: string; displayName: string; orgName?: string | undefined },
    passwordHash: string,
    inTx: ((account: Account) => Promise<T>) | undefined,
  ): Promise<{ account: Account; org?: Org; extra: T | undefined }> {
    await this.setupLock.lock();
    if ((await this.accounts.countEnterpriseAdmins()) > 0) throw alreadyCompleted();
    const account = await this.accounts.createLocal(
      {
        login: input.login,
        password: input.password,
        displayName: input.displayName,
        enterpriseAdmin: true,
      },
      passwordHash,
    );
    const org =
      input.orgName !== undefined
        ? await this.orgs.create({ name: input.orgName }, account)
        : undefined;
    await audit(this.db.db, {
      actorAccountId: account.id,
      action: "deployment.setup_completed",
      target: account.id,
      ...(org && { orgId: org.id, detail: { orgId: org.id } }),
    });
    const extra = inTx ? await inTx(account) : undefined;
    return { account, ...(org && { org }), extra };
  }
}
