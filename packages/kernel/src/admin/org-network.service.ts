import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import type { WriteActor } from "../identity/write-actor.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import {
  allowanceEntryProblem,
  type OrgNetworkAllowance,
  OrgNetworkAllowances,
} from "../orgs/network-allowances.service.js";
import { OrgsService } from "../orgs/orgs.service.js";

/**
 * The super admin's side of the org network allowances (plugin safe fetch spec): the admin routes
 * and their Platform operations call it. Writes take the super admin lock and re-check the actor
 * in the same transaction as the store's write (`OrgNetworkAllowances` joins it).
 *
 * Only a person widens: an add is refused for an API token or the Platform tool (`onlyNarrows`)
 * with `org.network_allowance_widen_not_allowed`; listing and removing stay open to both.
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
    await this.assertOrg(orgId);
    return this.allowances.list(orgId);
  }

  /**
   * The read-only preconditions of {@link add}, throwing its own refusals: `onlyNarrows` →
   * `org.network_allowance_widen_not_allowed`, a missing org → `org.not_found`, an invalid entry →
   * `org.network_allowance_invalid` (the cap is checked by the write only).
   */
  async checkAdd(orgId: string, entry: string, onlyNarrows: boolean): Promise<void> {
    assertWidenAllowed(onlyNarrows);
    await this.assertOrg(orgId);
    const problem = allowanceEntryProblem(entry);
    if (problem !== null) {
      throw new ApiError("org.network_allowance_invalid", `${entry.trim()}: ${problem}`);
    }
  }

  /**
   * Adds an entry (audited `org.network_allowance_added`); an entry already listed is returned.
   * `onlyNarrows` (an API token, the Platform tool) refuses it: only a person widens. The actor's
   * token id and `auditDetail` go into the audit event.
   */
  @Transactional()
  async add(
    orgId: string,
    entry: string,
    actor: WriteActor,
    onlyNarrows: boolean,
    auditDetail: Record<string, unknown> = {},
  ): Promise<OrgNetworkAllowance> {
    assertWidenAllowed(onlyNarrows);
    await this.adminLock.lockAndAuthorize(actor.accountId);
    return this.allowances.add(orgId, entry, actor, auditDetail);
  }

  /**
   * Removes the org's entry `id` (audited `org.network_allowance_removed`); a missing or deleted
   * org is `org.not_found`, an id the org does not list `org.network_allowance_not_found`. The
   * actor's token id and `auditDetail` go into the audit event.
   */
  @Transactional()
  async remove(
    orgId: string,
    id: string,
    actor: WriteActor,
    auditDetail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor.accountId);
    await this.assertOrg(orgId);
    if (!(await this.allowances.remove(orgId, id, actor, auditDetail))) {
      throw new ApiError(
        "org.network_allowance_not_found",
        "The organization has no such internal endpoint allowance",
      );
    }
  }

  private async assertOrg(orgId: string): Promise<void> {
    if ((await this.orgs.get(orgId)) === undefined) {
      throw new ApiError("org.not_found", "Organization not found");
    }
  }
}

/** Only a person in a web session widens what an org's extension requests may reach. */
function assertWidenAllowed(onlyNarrows: boolean): void {
  if (onlyNarrows) {
    throw new ApiError(
      "org.network_allowance_widen_not_allowed",
      "Allowing an internal endpoint needs a super admin in the admin console on the web, not an API token or the Platform tool.",
    );
  }
}
