import { Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  EnvironmentCreateBodyDto,
  type EnvironmentNameBody,
  type EnvironmentParams,
  EnvironmentParamsDto,
  EnvironmentRenameBodyDto,
} from "./dto.js";
import {
  type EnvironmentList,
  EnvironmentsService,
  type EnvironmentView,
} from "./environments.service.js";

/**
 * A person's environments in an org (`/api/v1/orgs/:orgId/environments`, spec
 * 2026-11-07-environments-design §9; `agents.use`, human users only: a service token gets 403).
 * Phase 1 has personal cloud environments only, each visible to its owner alone: another member
 * gets 404 `environment.not_found`.
 * - `GET /` → `{ items, defaultId, lastUsedId, cloudAvailable }` (`cloudAvailable`: there is a
 *   current sandbox provider; ruling R4);
 * - `POST / { name }` → 201 `{ environment }`; `GET /:id`, `PATCH /:id { name }` → `{ environment }`;
 * - `DELETE /:id` → 202 (destroyed by a job after the response);
 * - `POST /:id/files/reset` → 202 (the reset is enqueued: a worker empties the files, the next use
 *   starts empty).
 */
@Controller("api/v1/orgs/:orgId/environments")
export class EnvironmentsController {
  constructor(@Inject(EnvironmentsService) private readonly environments: EnvironmentsService) {}

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<EnvironmentList> {
    const p = requireUser(principal);
    return this.environments.list(org.orgId, p.account.id);
  }

  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(EnvironmentCreateBodyDto) body: z.infer<typeof EnvironmentNameBody>,
  ): Promise<{ environment: EnvironmentView }> {
    const p = requireUser(principal);
    return {
      environment: await this.environments.create(
        org.orgId,
        p.account.id,
        { name: body.name },
        patTokenId(p),
      ),
    };
  }

  @Get(":id")
  @OrgAction("agents.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(EnvironmentParamsDto) params: z.infer<typeof EnvironmentParams>,
  ): Promise<{ environment: EnvironmentView }> {
    const p = requireUser(principal);
    return { environment: await this.environments.get(org.orgId, p.account.id, params.id) };
  }

  @Patch(":id")
  @OrgAction("agents.use")
  async rename(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(EnvironmentParamsDto) params: z.infer<typeof EnvironmentParams>,
    @ZBody(EnvironmentRenameBodyDto) body: z.infer<typeof EnvironmentNameBody>,
  ): Promise<{ environment: EnvironmentView }> {
    const p = requireUser(principal);
    return {
      environment: await this.environments.rename(
        org.orgId,
        p.account.id,
        params.id,
        body.name,
        patTokenId(p),
      ),
    };
  }

  @Delete(":id")
  @HttpCode(202)
  @OrgAction("agents.use")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(EnvironmentParamsDto) params: z.infer<typeof EnvironmentParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.environments.remove(org.orgId, p.account.id, params.id, patTokenId(p));
  }

  @Post(":id/files/reset")
  @HttpCode(202)
  @OrgAction("agents.use")
  async resetFiles(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(EnvironmentParamsDto) params: z.infer<typeof EnvironmentParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.environments.resetFiles(org.orgId, p.account.id, params.id, patTokenId(p));
  }
}
