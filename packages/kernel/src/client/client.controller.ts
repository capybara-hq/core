import { Controller, Get, Header, HttpCode, Inject, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { Throttled } from "../infra/throttler/throttler.guard.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { AdminClientQuery, type ClientExtensionsResponse, ReportBody } from "./client.schemas.js";
import { ClientAccess } from "./client-access.service.js";
import { ClientReports } from "./client-reports.service.js";
import { ClientSignIn } from "./client-sign-in.service.js";

class AdminClientQueryDto extends createZodDto(AdminClientQuery, "AdminClientQuery") {}
class ReportBodyDto extends createZodDto(ReportBody, "ClientReportBody") {}

/**
 * The workspace shell read of client extensions (client extensions spec §9.2), `ui.use` (guest and
 * up; a person, not a service token): `GET /api/v1/orgs/:orgId/ui/client` →
 * {@link ClientExtensionsResponse}: the extensions enabled in the org that run with an approved
 * client build, their file URLs and integrity, the components the caller's role may use and the
 * caller's sign-in id per plugin (`ClientSignIn`);
 * `enabled: false` with no items under the kill switch. `no-store`: the set changes with an org
 * switch, an upgrade or the kill switch.
 */
@Controller("api/v1/orgs/:orgId/ui/client")
export class OrgClientController {
  constructor(
    @Inject(ClientAccess) private readonly access: ClientAccess,
    @Inject(ClientReports) private readonly reports: ClientReports,
    @Inject(ClientSignIn) private readonly signIn: ClientSignIn,
  ) {}

  @Get()
  @OrgAction("ui.use")
  @Header("cache-control", "no-store")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<ClientExtensionsResponse> {
    const user = requireUser(principal);
    return this.access.orgSet(org.orgId, org.role, this.signIn.of(user));
  }

  /**
   * `POST /api/v1/orgs/:orgId/ui/client/reports` (spec §10.4), `ui.use`, a person, 20 per minute
   * per account (`client-reports`): a crash or load report of client code → 204. 404
   * `client.not_found` for an extension not on in the org or a build the caller cannot fetch; 400
   * for a message over 500 characters.
   */
  @Post("reports")
  @OrgAction("ui.use")
  @HttpCode(204)
  @Throttled("client-reports")
  async report(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ReportBodyDto) body: z.infer<typeof ReportBody>,
  ): Promise<void> {
    const user = requireUser(principal);
    await this.reports.recordForOrg(user.account.id, org.orgId, body);
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
  constructor(
    @Inject(ClientAccess) private readonly access: ClientAccess,
    @Inject(ClientReports) private readonly reports: ClientReports,
    @Inject(ClientSignIn) private readonly signIn: ClientSignIn,
  ) {}

  @Get()
  @Header("cache-control", "no-store")
  async list(
    @CurrentPrincipal() principal: Principal,
    @ZQuery(AdminClientQueryDto) q: z.infer<typeof AdminClientQuery>,
  ): Promise<ClientExtensionsResponse> {
    const user = requireUser(principal);
    return this.access.platformSet(this.signIn.of(user), q.plugin);
  }

  /**
   * `POST /api/v1/admin/ui/client/reports` (spec §10.4), super admins, 20 per minute per account:
   * a report from an admin page (stored with no org) → 204; 404 `client.not_found` for a build
   * that has no `platform.page` component or is not served.
   */
  @Post("reports")
  @HttpCode(204)
  @Throttled("client-reports")
  async report(
    @CurrentPrincipal() principal: Principal,
    @ZBody(ReportBodyDto) body: z.infer<typeof ReportBody>,
  ): Promise<void> {
    const user = requireUser(principal);
    await this.reports.recordForAdmin(user.account.id, body);
  }
}
