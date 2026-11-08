import { Inject, Injectable } from "@nestjs/common";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";

/**
 * Serializes the install record writes of one extension name (install, enable, disable, uninstall),
 * including a first install that has no row to lock yet. Joins the caller's transaction
 * (`mandatory`), which holds the lock until it ends.
 */
@Injectable()
export class PluginInstallLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(name: string): Promise<void> {
    await this.xactLock.lock(`capybara.plugin-install:${name}`);
  }
}

/**
 * Serializes the permission snapshot writes of one extension (web approval, the bootstrap step's
 * approval of a stored package). Joins the caller's transaction (`mandatory`).
 */
@Injectable()
export class PluginApproveLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(name: string): Promise<void> {
    await this.xactLock.lock(`capybara.plugin-approve:${name}`);
  }
}

/**
 * Serializes the deployment config writes of one extension. Joins the caller's transaction
 * (`mandatory`).
 */
@Injectable()
export class PluginDeploymentConfigLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(name: string): Promise<void> {
    await this.xactLock.lock(`capybara.plugin-deployment-config:${name}`);
  }
}

/**
 * Serializes the enables of the providers of one single-provider extension point (`sandbox@2`, …):
 * two concurrent enables of different providers cannot both see the point free. Joins the
 * caller's transaction (`mandatory`); taken after the install lock of the extension's name, the
 * points in sorted order.
 */
@Injectable()
export class SingleProviderLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(extensionPoint: string): Promise<void> {
    await this.xactLock.lock(`capybara.single-provider:${extensionPoint}`);
  }
}
