import { Inject, Injectable } from "@nestjs/common";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/**
 * The watched-wait lock of one (org, account) (browser long waits spec §5.2, decision R9: one
 * provider per transaction-scoped lock): serializes watched asks of the account in the org, so the
 * count of its pending watched questions checked against `tools.maxWatchedWaitsPerAccount` and
 * the insert of the new one are one step. Joins the caller's transaction (`mandatory`, a tool
 * step's: admitted exclusively), which holds it until it ends.
 */
@Injectable()
export class WatchedWaitsLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(orgId: string, accountId: string): Promise<void> {
    await this.xactLock.lock(`capybara.watched-waits:${orgId}:${accountId}`);
  }
}
