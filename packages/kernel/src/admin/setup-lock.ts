import { Inject, Injectable, Module } from "@nestjs/common";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/** The transaction-scoped lock name of deployment setup. */
const SETUP_LOCK = "capybara.setup";

/**
 * The deployment setup lock (one provider per transaction-scoped lock): serializes the web setup
 * wizard and the CLI's `admin create --if-none`, so concurrent runs create exactly one enterprise
 * admin. Joins the caller's transaction (`mandatory`), which holds it until it ends.
 */
@Injectable()
export class SetupLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(): Promise<void> {
    await this.xactLock.lock(SETUP_LOCK);
  }
}

/** The one {@link SetupLock}: identity (the CLI's admin creation) and admin import it. */
@Module({ providers: [SetupLock], exports: [SetupLock] })
export class SetupLockModule {}
