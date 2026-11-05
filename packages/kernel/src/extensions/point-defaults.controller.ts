import { Controller, Get, HttpCode, Inject, Put } from "@nestjs/common";
import { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ExtensionPointDefaults, type OrgPointDefaultView } from "./point-defaults.js";

const PointParams = z.object({ point: z.string().min(1).max(100) });
const DefaultBody = z.object({ extension: z.string().min(1).max(214) }).strict();

class ExtensionPointParamsDto extends createZodDto(PointParams, "ExtensionPointParams") {}
class ExtensionPointDefaultBodyDto extends createZodDto(DefaultBody, "ExtensionPointDefaultBody") {}

/**
 * The org default provider of `org-default` extension points (web tools spec §6):
 * - `GET /api/v1/orgs/:orgId/extension-points` (`org.extensions.manage`) → `{ points }`: each
 *   point with its candidate providers, the stored default and the effective provider;
 * - `PUT /api/v1/orgs/:orgId/extension-points/:point/default` `{ extension }`
 *   (`org.extensions.manage`) → 204;
 * - `GET /api/v1/orgs/:orgId/extension-points/available` (`agents.use`) → `{ points }`: whether
 *   each point has a provider now, without extension names (for the agent form).
 */
@Controller("api/v1/orgs/:orgId/extension-points")
export class ExtensionPointDefaultsController {
  constructor(@Inject(ExtensionPointDefaults) private readonly points: ExtensionPointDefaults) {}

  @Get()
  @OrgAction("org.extensions.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ points: OrgPointDefaultView[] }> {
    return { points: await this.points.list(org.orgId) };
  }

  @Get("available")
  @OrgAction("agents.use")
  async available(
    @CurrentOrg() org: OrgContext,
  ): Promise<{ points: { point: string; available: boolean }[] }> {
    return { points: await this.points.available(org.orgId) };
  }

  @Put(":point/default")
  @HttpCode(204)
  @OrgAction("org.extensions.manage")
  async setDefault(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ExtensionPointParamsDto) { point }: z.infer<typeof PointParams>,
    @ZBody(ExtensionPointDefaultBodyDto) body: z.infer<typeof DefaultBody>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.points.setDefault(org.orgId, point, body.extension, p.account.id);
  }
}
