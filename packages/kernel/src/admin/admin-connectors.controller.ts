import { Controller, Delete, Get, HttpCode, Inject, Patch } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, SuperAdmin } from "../identity/principal.js";
import { writeActorOf } from "../identity/write-actor.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import {
  type AdminConnectorDetail,
  type AdminConnectorRow,
  AdminConnectors,
} from "../tools/admin-connectors.js";
import { ConnectorsService } from "../tools/connectors.service.js";
import {
  AdminConnectorListQuery,
  ConnectorIdParams,
  ConnectorStatusBody,
} from "./admin-items.schemas.js";

class AdminConnectorListQueryDto extends createZodDto(
  AdminConnectorListQuery,
  "AdminConnectorListQuery",
) {}
class AdminConnectorIdParamsDto extends createZodDto(ConnectorIdParams, "AdminConnectorIdParams") {}
class ConnectorStatusBodyDto extends createZodDto(
  ConnectorStatusBody,
  "AdminConnectorStatusBody",
) {}

/**
 * Every org's connectors for the super admin (admin agents and connectors spec §4.1): read any
 * connector without its credentials, disable or enable it, delete it. The super admin need not be
 * a member of the connector's org; each write is audited there with `detail.via = "platform"`.
 */
@Controller("api/v1/admin/connectors")
@SuperAdmin()
export class AdminConnectorsController {
  constructor(
    @Inject(AdminConnectors) private readonly admin: AdminConnectors,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
  ) {}

  /** Live connectors of live orgs by id; `next` is the `after` of the next page, null at the end. */
  @Get()
  list(
    @ZQuery(AdminConnectorListQueryDto) q: z.infer<typeof AdminConnectorListQuery>,
  ): Promise<{ connectors: AdminConnectorRow[]; next: string | null }> {
    return this.admin.list(q);
  }

  @Get(":connectorId")
  async get(
    @ZParam(AdminConnectorIdParamsDto) { connectorId }: z.infer<typeof ConnectorIdParams>,
  ): Promise<{ connector: AdminConnectorDetail }> {
    return { connector: await this.admin.get(connectorId) };
  }

  /** Disables or enables the connector (its endpoint and auth stay the org's to edit). */
  @Patch(":connectorId")
  async setStatus(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminConnectorIdParamsDto) { connectorId }: z.infer<typeof ConnectorIdParams>,
    @ZBody(ConnectorStatusBodyDto) body: z.infer<typeof ConnectorStatusBody>,
  ): Promise<{ connector: AdminConnectorDetail }> {
    await this.connectors.setStatusAsPlatform(connectorId, body.status, writeActorOf(principal));
    return { connector: await this.admin.get(connectorId) };
  }

  /** Deletes the connector and every credential of it. */
  @Delete(":connectorId")
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @ZParam(AdminConnectorIdParamsDto) { connectorId }: z.infer<typeof ConnectorIdParams>,
  ): Promise<void> {
    await this.connectors.removeAsPlatform(connectorId, writeActorOf(principal));
  }
}
