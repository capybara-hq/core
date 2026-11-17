import { Controller, Delete, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { type NetworkAllowanceView, networkAllowanceView } from "../orgs/orgs.schemas.js";
import { AdminOrgParams } from "./admin.schemas.js";
import { NetworkAllowanceBody, NetworkAllowanceParams } from "./org-network.schemas.js";
import { OrgNetworkAdmin } from "./org-network.service.js";

class AdminOrgNetworkParamsDto extends createZodDto(AdminOrgParams, "AdminOrgNetworkParams") {}
class NetworkAllowanceItemParamsDto extends createZodDto(
  AdminOrgParams.extend(NetworkAllowanceParams.shape),
  "NetworkAllowanceItemParams",
) {}
class NetworkAllowanceBodyDto extends createZodDto(NetworkAllowanceBody, "NetworkAllowanceBody") {}

/**
 * An org's network allowances (`/api/v1/admin/orgs/:orgId/network-allowances`, plugin safe fetch
 * spec): the internal endpoints the org's extension requests may reach although they resolve to
 * private or loopback addresses. Super admins only (service tokens 403); adding and removing are
 * audited `org.network_allowance_added` / `org.network_allowance_removed`. Org admins read their
 * org's list at `GET /api/v1/orgs/:orgId/network-allowances`.
 */
@Controller("api/v1/admin/orgs/:orgId/network-allowances")
@SuperAdmin()
export class AdminOrgNetworkController {
  constructor(@Inject(OrgNetworkAdmin) private readonly admin: OrgNetworkAdmin) {}

  /** The org's entries, oldest first; a missing or deleted org → `org.not_found`. */
  @Get()
  async list(
    @ZParam(AdminOrgNetworkParamsDto) { orgId }: z.infer<typeof AdminOrgParams>,
  ): Promise<{ allowances: NetworkAllowanceView[] }> {
    return { allowances: (await this.admin.list(orgId)).map(networkAllowanceView) };
  }

  /**
   * Adds an entry; an invalid one → 400 `org.network_allowance_invalid` with the reason. Only a
   * person widens: a personal access token → 400 `org.network_allowance_widen_not_allowed`.
   */
  @Post()
  @HttpCode(201)
  async add(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminOrgNetworkParamsDto) { orgId }: z.infer<typeof AdminOrgParams>,
    @ZBody(NetworkAllowanceBodyDto) body: z.infer<typeof NetworkAllowanceBody>,
  ): Promise<{ allowance: NetworkAllowanceView }> {
    const actor = requireUser(principal);
    const allowance = await this.admin.add(
      orgId,
      body.entry,
      actor.account.id,
      patTokenId(actor) !== undefined,
    );
    return { allowance: networkAllowanceView(allowance) };
  }

  /** Removes an entry; an id the org does not list → 404 `org.network_allowance_not_found`. */
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @ZParam(NetworkAllowanceItemParamsDto)
    { orgId, id }: z.infer<typeof AdminOrgParams> & z.infer<typeof NetworkAllowanceParams>,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.admin.remove(orgId, id, actor.account.id);
  }
}
