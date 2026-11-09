import { Inject, Injectable } from "@nestjs/common";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/**
 * The launch lock of one root conversation (decision R9: one provider per transaction-scoped
 * lock): serializes background task reservations in its tree, so the count of running tasks
 * checked against `sandbox.background.maxTasks` (per root conversation, whatever device it
 * works in) and the insert of the new row are one step. Joins the
 * caller's transaction (`mandatory`), which holds it until it ends.
 */
@Injectable()
export class BackgroundLaunchLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(sandboxConversationId: string): Promise<void> {
    await this.xactLock.lock(`capybara.background-launch:${sandboxConversationId}`);
  }
}
