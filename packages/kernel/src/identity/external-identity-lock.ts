import { Inject, Injectable } from "@nestjs/common";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/**
 * The lock of one external identity (R9: one provider per lock): serializes resolve / link of the
 * same `(source, externalId)`, whose row may not exist yet, so concurrent first resolves create one
 * account. Joins the caller's transaction (`mandatory`), which holds it until it ends.
 */
@Injectable()
export class ExternalIdentityLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(id: { source: string; externalId: string }): Promise<void> {
    await this.xactLock.lock(`capybara.identity:${id.source}:${id.externalId}`);
  }
}
