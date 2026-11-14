import type { DeviceLocalPolicySummary } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "../errors.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
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
} from "./dto.js";

/**
 * A person's devices in an org (`/api/v1/orgs/:orgId/devices`, spec
 * 2026-11-07-environments-design §9; `agents.use`, human users only: a service token gets 403).
 * Phase 1 has personal cloud devices only, each visible to its owner alone: another member
 * gets 404 `device.not_found`.
 * - `GET /` → `{ items, defaultId, lastUsedId, cloudAvailable }` (`cloudAvailable`: there is a
 *   current sandbox provider; ruling R4);
 * - `POST / { name }` → 201 `{ device }`; `GET /:id` → `{ device }`;
 * - `PATCH /:id { name?, mode? }` → `{ device }`: renames it and narrows a cloud device to sandbox
 *   mode (`mode: "sandbox"` only, auto mode spec §4.3; its network then follows the org's
 *   `cloudNetwork`). A local device's mode lives on its machine (`device.mode_on_device`; change it
 *   with `POST /:id/policy { mode }` or the local CLI). The mode is set in a web session only
 *   (an API token → 403 `auth.session_required`);
 * - `DELETE /:id` → 202 (destroyed by a job after the response);
 * - `POST /:id/files/reset` → 202 (the reset is enqueued: a worker empties the files, the next use
 *   starts empty);
 * - `DELETE /:id/machine` → 204: a local device's machine is disconnected (its credential
 *   revoked; it must sign in again);
 * - `POST /:id/policy { add?, remove?, mode? }` → `{ policy }`: the owner changes the local
 *   device's policy on its machine (network ask-to-allow spec §7; auto mode spec §4.1;
 *   `mode` is only ever `sandbox`). Web session only
 *   (`@SessionOnly`: a personal access token → 403 `auth.session_required`, a service token → 403):
 *   a person changes their own machine's network policy, nothing model-driven does. Offline → 503
 *   `device.offline`; cloud or an older program → 409 `device.policy_unsupported`; the machine's
 *   refusal → 409 `device.policy_refused`.
 */
@Controller("api/v1/orgs/:orgId/devices")
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

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
    // a person changes their device's mode in a session (auto mode spec §4.3)
    if (body.mode !== undefined && tokenId !== undefined) {
      throw new ApiError(
        "auth.session_required",
        "A device's mode is changed by its owner on the web, not with an API token",
      );
    }
    return {
      device: await this.devices.update(
        org.orgId,
        p.account.id,
        params.id,
        {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.mode !== undefined && { mode: body.mode }),
        },
        tokenId,
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
}
