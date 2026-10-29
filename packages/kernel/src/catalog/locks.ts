import { Inject, Injectable } from "@nestjs/common";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/**
 * Serializes the writes of one marketplace's cached entries and refresh status (a refresh's
 * result against concurrent refreshes and the admin's changes). Joins the caller's transaction
 * (`mandatory`, R9 / R12), which holds the lock until it ends.
 */
@Injectable()
export class CatalogSourceLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(marketplaceId: string): Promise<void> {
    await this.xactLock.lock(`capybara.catalog-source:${marketplaceId}`);
  }
}

/**
 * Serializes the imports of one catalog item name (the conflict re-check and the item / version
 * write of a confirm), including a first import that has no item row to lock yet. Joins the
 * caller's transaction (`mandatory`, R9 / R12).
 */
@Injectable()
export class CatalogItemLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(name: string): Promise<void> {
    await this.xactLock.lock(`capybara.directory-item:${name}`);
  }
}
