import { Controller, Get, Header, Inject } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { AdminClientQuery, type ClientExtensionsResponse } from "./client.schemas.js";
import { ClientAccess } from "./client-access.service.js";

class AdminClientQueryDto extends createZodDto(AdminClientQuery, "AdminClientQuery") {}

/**
 * The workspace shell read of client extensions (client extensions spec §9.2), `ui.use` (guest and
 * up; a person, not a service token): `GET /api/v1/orgs/:orgId/ui/client` →
 * {@link ClientExtensionsResponse}: the extensions enabled in the org that run with an approved
 * client build, their file URLs and integrity, and the components the caller's role may use;
 * `enabled: false` with no items under the kill switch. `no-store`: the set changes with an org
 * switch, an upgrade or the kill switch.
 */
@Controller("api/v1/orgs/:orgId/ui/client")
export class OrgClientController {
  constructor(@Inject(ClientAccess) private readonly access: ClientAccess) {}

  @Get()
  @OrgAction("ui.use")
  @Header("cache-control", "no-store")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<ClientExtensionsResponse> {
    requireUser(principal);
    return this.access.orgSet(org.orgId, org.role);
  }
}

/**
 * The admin console's client set (spec §9.6), super admins only: `GET /api/v1/admin/ui/client
 * ?plugin=` → {@link ClientExtensionsResponse} with only `platform.page` components and no
 * stylesheets (the admin console runs no org client code); with `plugin`, at most that one (the
 * page `/admin/p/<plugin>/<id>` reads its own). `no-store`.
 */
@Controller("api/v1/admin/ui/client")
@SuperAdmin()
export class AdminClientController {
  constructor(@Inject(ClientAccess) private readonly access: ClientAccess) {}

  @Get()
  @Header("cache-control", "no-store")
  async list(
    @CurrentPrincipal() principal: Principal,
    @ZQuery(AdminClientQueryDto) q: z.infer<typeof AdminClientQuery>,
  ): Promise<ClientExtensionsResponse> {
    requireUser(principal);
    return this.access.platformSet(q.plugin);
  }
}
