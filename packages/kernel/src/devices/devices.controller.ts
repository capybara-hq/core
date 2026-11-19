import type { DeviceLocalPolicySummary } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type DeviceProjectCandidates,
  type DeviceProjectList,
  DeviceProjectsService,
  type DeviceProjectView,
} from "./device-projects.service.js";
import { type DeviceList, DevicesService, type DeviceView } from "./devices.service.js";
import {
  DeviceCreateBodyDto,
  type DeviceNameBody,
  type DeviceParams,
  DeviceParamsDto,
  type DevicePatchBody,
  DevicePatchBodyDto,
  type DevicePolicyBody,
  DevicePolicyBodyDto,
  type DeviceProjectAddBody,
  DeviceProjectAddBodyDto,
  type DeviceProjectParams,
  DeviceProjectParamsDto,
} from "./dto.js";

/**
 * A person's devices in an org (`/api/v1/orgs/:orgId/devices`, spec
 * 2026-11-07-environments-design §9; `agents.use`, human users only: a service token gets 403).
 * Phase 1 has personal cloud devices only, each visible to its owner alone: another member
 * gets 404 `device.not_found`.
 * - `GET /` → `{ items, defaultId, lastUsedId, cloudAvailable }` (`cloudAvailable`: there is a
 *   current sandbox provider; ruling R4);
 * - `POST / { name }` → 201 `{ device }`; `GET /:id` → `{ device }`;
 * - `PATCH /:id { name?, network? }` → `{ device }`: renames it and sets a cloud device's sandbox
 *   network (`{ mode: open | allowlist | none | null, hosts? }`, approval-only profiles design,
 *   "Settings model") within its org's and the platform's ceilings (400
 *   `device.network_not_allowed` above them). A local device's network lives on its machine (409
 *   `device.ceiling_on_machine`; narrow it with `POST /:id/policy`). An API token may only narrow
 *   it (400 `device.network_not_allowed`);
 * - `DELETE /:id` → 202 (destroyed by a job after the response);
 * - `POST /:id/files/reset` → 202 (the reset is enqueued: a worker empties the files, the next use
 *   starts empty);
 * - `DELETE /:id/machine` → 204: a local device's machine is disconnected (its credential
 *   revoked; it must sign in again);
 * - `POST /:id/policy { remove?, ownerCeiling? }` → `{ policy }`: the owner narrows the local
 *   device's sandbox on its machine (hosts removed; `outsideSandbox: false`, `network:
 *   "allowlist"`, `restrictedProjectReach: "workspace"`); widening happens on the machine only.
 *   Web session only
 *   (`@SessionOnly`: a personal access token → 403 `auth.session_required`, a service token → 403):
 *   a person changes their own machine's network policy, nothing model-driven does. Offline → 503
 *   `device.offline`; cloud or an older program → 409 `device.policy_unsupported`; the machine's
 *   refusal → 409 `device.policy_refused`.
 * - a device's projects (project root design §4.1, §4.2), owner only (anyone else:
 *   `device.not_found`): `GET /:id/projects` → the ones its current mode can read;
 *   `GET /:id/projects/candidates` → the device's suggestions under its base;
 *   `POST /:id/projects { path, name? }` → 201 `{ project }` (path relative to the base);
 *   `DELETE /:id/projects/:name` → 204 (idempotent).
 */
@Controller("api/v1/orgs/:orgId/devices")
export class DevicesController {
  constructor(
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(DeviceProjectsService) private readonly projects: DeviceProjectsService,
  ) {}

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<DeviceList> {
    const p = requireUser(principal);
    return this.devices.list(org.orgId, p.account.id);
  }

  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(DeviceCreateBodyDto) body: z.infer<typeof DeviceNameBody>,
  ): Promise<{ device: DeviceView }> {
    const p = requireUser(principal);
    return {
      device: await this.devices.create(
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

  @Delete(":id/machine")
  @HttpCode(204)
  @OrgAction("agents.use")
  async revokeMachine(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.devices.revokeMachine(org.orgId, p.account.id, params.id, patTokenId(p));
  }

  @Post(":id/policy")
  @HttpCode(200)
  @SessionOnly()
  @OrgAction("agents.use")
  async changePolicy(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(DeviceParamsDto) params: z.infer<typeof DeviceParams>,
    @ZBody(DevicePolicyBodyDto) body: z.infer<typeof DevicePolicyBody>,
  ): Promise<{ policy: DeviceLocalPolicySummary }> {
    const p = requireUser(principal);
    return {
      policy: await this.devices.changePolicy(org.orgId, p.account, params.id, body),
    };
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
