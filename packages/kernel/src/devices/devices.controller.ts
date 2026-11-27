import { Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { DeviceProjectFilesService, type ProjectFileList } from "./device-project-files.service.js";
import {
  type DeviceProjectCandidates,
  type DeviceProjectList,
  DeviceProjectsService,
  type DeviceProjectView,
} from "./device-projects.service.js";
import { type DeviceList, DevicesService, type DeviceView } from "./devices.service.js";
import {
  type DeviceCreateBody,
  DeviceCreateBodyDto,
  type DeviceParams,
  DeviceParamsDto,
  type DevicePatchBody,
  DevicePatchBodyDto,
  type DeviceProjectAddBody,
  DeviceProjectAddBodyDto,
  type DeviceProjectFilesQuery,
  DeviceProjectFilesQueryDto,
  type DeviceProjectParams,
  DeviceProjectParamsDto,
} from "./dto.js";

/**
 * A person's devices in an org (`/api/v1/orgs/:orgId/devices`, spec
 * 2026-11-07-environments-design §9; `agents.use`, human users only: a service token gets 403).
 * Phase 1 has personal cloud devices only, each visible to its owner alone: another member
 * gets 404 `device.not_found`.
 * - `GET /` → `{ items, defaultId, lastUsedId, providers, defaultProvider }` (`providers`: the
 *   device providers on in the org, `{ plugin, displayName, description, dialIn, guide }`; `defaultProvider`: the one a device
 *   gets when none is named, null when none serves the org);
 * - `POST / { name, provider? }` → 201 `{ device }`, bound for life to `provider` (one of
 *   `providers`, else 400 `validation_failed` at `provider`) or the default provider (none: 400
 *   `device.provider_required`; a dial-in provider: 409 `device.provider_dial_in`, its devices are
 *   made by the machine); `GET /:id` → `{ device }`;
 * - `PATCH /:id { name?, network? }` → `{ device }`: renames it and sets its sandbox network
 *   (`{ mode: open | allowlist | none | null, hosts? }`, approval-only profiles design, "Settings
 *   model") within its org's and the platform's ceilings (400 `device.network_not_allowed` above
 *   them), whatever its provider. An API token may only narrow it (400
 *   `device.network_not_allowed`);
 * - `DELETE /:id` → 202 (destroyed by a job after the response);
 * - `POST /:id/files/reset` → 202 (the reset is enqueued: a worker empties the files, the next use
 *   starts empty; 409 `device.files_on_device` when its provider's report offers no reset);
 * - a device's projects (project root design §4.1, §4.2), owner only (anyone else:
 *   `device.not_found`): `GET /:id/projects` → the ones its current mode can read;
 *   `GET /:id/projects/candidates` → the device's suggestions under its base;
 *   `POST /:id/projects { path, name? }` → 201 `{ project }` (path relative to the base);
 *   `DELETE /:id/projects/:name` → 204 (idempotent);
 *   `GET /:id/projects/:name/files?path=&q=` → `{ entries, truncated }`: one directory of the
 *   project (path relative to its root; 422 `device.path_outside_project` for one leaving it),
 *   read through the owner browse scope (composer menus §5).
 */
@Controller("api/v1/orgs/:orgId/devices")
export class DevicesController {
  constructor(
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(DeviceProjectsService) private readonly projects: DeviceProjectsService,
    @Inject(DeviceProjectFilesService) private readonly files: DeviceProjectFilesService,
  ) {}

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<DeviceList> {
    const p = requireUser(principal);
    return this.devices.list(org.orgId, p.account.id, org.role);
  }

  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(DeviceCreateBodyDto) body: z.infer<typeof DeviceCreateBody>,
  ): Promise<{ device: DeviceView }> {
    const p = requireUser(principal);
    return {
      device: await this.devices.create(
        org.orgId,
        p.account.id,
        { name: body.name, ...(body.provider !== undefined && { provider: body.provider }) },
        patTokenId(p),
      ),
    };
  }

  @Get(":id")
  @OrgAction("agents.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
  ): Promise<{ device: DeviceView }> {
    const p = requireUser(principal);
    return { device: await this.devices.get(org.orgId, p.account.id, params.id) };
  }

  @Patch(":id")
  @OrgAction("agents.use")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
    @ZBody(DevicePatchBodyDto) body: z.infer<typeof DevicePatchBody>,
  ): Promise<{ device: DeviceView }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      device: await this.devices.update(
        org.orgId,
        p.account.id,
        params.id,
        {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.network !== undefined && { network: body.network }),
        },
        tokenId,
        // an API token may narrow the network, never widen it (approval-only profiles design)
        { narrowOnly: tokenId !== undefined },
      ),
    };
  }

  @Delete(":id")
  @HttpCode(202)
  @OrgAction("agents.use")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.devices.remove(org.orgId, p.account.id, params.id, patTokenId(p));
  }

  @Post(":id/files/reset")
  @HttpCode(202)
  @OrgAction("agents.use")
  async resetFiles(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.devices.resetFiles(org.orgId, p.account.id, params.id, patTokenId(p));
  }

  @Get(":id/projects")
  @OrgAction("agents.use")
  async listProjects(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
  ): Promise<DeviceProjectList> {
    const p = requireUser(principal);
    return this.projects.list(org.orgId, p.account.id, params.id);
  }

  @Get(":id/projects/candidates")
  @OrgAction("agents.use")
  async projectCandidates(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
  ): Promise<DeviceProjectCandidates> {
    const p = requireUser(principal);
    return this.projects.candidates(org.orgId, p.account.id, params.id);
  }

  @Get(":id/projects/:name/files")
  @OrgAction("agents.use")
  async listProjectFiles(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceProjectParamsDto) params: z.infer<typeof DeviceProjectParams>,
    @ZQuery(DeviceProjectFilesQueryDto) query: z.infer<typeof DeviceProjectFilesQuery>,
  ): Promise<ProjectFileList> {
    const p = requireUser(principal);
    return this.files.list(org.orgId, p.account.id, params.id, params.name, {
      ...(query.path !== undefined && { path: query.path }),
      ...(query.q !== undefined && { q: query.q }),
    });
  }

  @Post(":id/projects")
  @OrgAction("agents.use")
  async addProject(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
    @ZBody(DeviceProjectAddBodyDto) body: z.infer<typeof DeviceProjectAddBody>,
  ): Promise<{ project: DeviceProjectView }> {
    const p = requireUser(principal);
    return {
      project: await this.projects.add(
        org.orgId,
        p.account.id,
        params.id,
        { path: body.path, ...(body.name !== undefined && { name: body.name }) },
        patTokenId(p),
      ),
    };
  }

  @Delete(":id/projects/:name")
  @HttpCode(204)
  @OrgAction("agents.use")
  async removeProject(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceProjectParamsDto) params: z.infer<typeof DeviceProjectParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.projects.remove(org.orgId, p.account.id, params.id, params.name, patTokenId(p));
  }
}
