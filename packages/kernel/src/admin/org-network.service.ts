import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import {
  type OrgNetworkAllowance,
  OrgNetworkAllowances,
} from "../orgs/network-allowances.service.js";
import { OrgsService } from "../orgs/orgs.service.js";

/**
 * The super admin's side of the org network allowances (plugin safe fetch spec): the admin routes
 * and their Platform operations call it. Writes take the super admin lock and re-check the actor
 * in the same transaction as the store's write (`OrgNetworkAllowances` joins it).
 */
@Injectable()
export class OrgNetworkAdmin {
  constructor(
    @Inject(OrgNetworkAllowances) private readonly allowances: OrgNetworkAllowances,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The org's entries, oldest first; a missing or deleted org is `org.not_found`. */
  async list(orgId: string): Promise<OrgNetworkAllowance[]> {
    if ((await this.orgs.get(orgId)) === undefined) {
      throw new ApiError("org.not_found", "Organization not found");
    }
    return this.allowances.list(orgId);
  }

  /** Adds an entry (audited `org.network_allowance_added`); an entry already listed is returned. */
  @Transactional()
  async add(orgId: string, entry: string, actorAccountId: string): Promise<OrgNetworkAllowance> {
    await this.adminLock.lockAndAuthorize(actorAccountId);
    return this.allowances.add(orgId, entry, actorAccountId);
  }

  /**
   * Removes the org's entry `id` (audited `org.network_allowance_removed`); an id the org does not
   * list is `org.network_allowance_not_found`.
   */
  @Transactional()
  async remove(orgId: string, id: string, actorAccountId: string): Promise<void> {
    await this.adminLock.lockAndAuthorize(actorAccountId);
    if (!(await this.allowances.remove(orgId, id, actorAccountId))) {
      throw new ApiError(
        "org.network_allowance_not_found",
        "The organization has no such internal endpoint allowance",
      );
    }
  }
}
