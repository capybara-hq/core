import { Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ScheduledTasksService } from "./scheduled-tasks.service.js";
import {
  createInputOf,
  grantsOf,
  type ScheduleCreateBody,
  ScheduleCreateBodyDto,
  type ScheduleGrantParams,
  ScheduleGrantParamsDto,
  type ScheduleGrantsBody,
  ScheduleGrantsBodyDto,
  type ScheduleListQuery,
  ScheduleListQueryDto,
  type ScheduleParams,
  ScheduleParamsDto,
  type ScheduleRunBody,
  ScheduleRunBodyDto,
  type ScheduleRunsQuery,
  ScheduleRunsQueryDto,
  type ScheduleUpdateBody,
  ScheduleUpdateBodyDto,
  updateInputOf,
} from "./schedules.schemas.js";
import type { ScheduledTask, ScheduledTaskGrant, TaskRun } from "./types.js";

/**
 * Scheduled tasks (`/api/v1/orgs/:orgId/schedules`, spec 2026-11-11-scheduled-tasks §10); human
 * users only (a service token gets 403).
 * - `GET /` → `{ items }`: the caller's own tasks; `?all=true` every task of the org (org admins,
 *   `schedules.manage`, enforced by the service: 403 `forbidden` otherwise);
 * - `POST /` → 201 `{ task }` (`timeZone` is the browser zone, a fallback only);
 *   `GET /:id`, `PATCH /:id`, `POST /:id/pause`, `POST /:id/resume` → `{ task }`;
 * - `DELETE /:id` → 204; `POST /:id/run { trial? }` → 202 `{ run }`;
 * - `GET /:id/runs?limit` → `{ items }`; `GET /:id/grants` → `{ items }`;
 *   `POST /:id/grants { grants }` → `{ items }`; `DELETE /:id/grants/:toolKey` → 204.
 *
 * Roles: create, edit, resume, run and the grants need `schedules.use` (member and up; a guest
 * gets 403). Pause and delete are `org.read` (any member, a guest included) so a creator demoted
 * to guest can still stop and remove their own tasks; the service decides by the live role and
 * ownership (the creator, or an org admin), and a task the caller may not see is 404
 * `schedule.not_found`.
 */
@Controller("api/v1/orgs/:orgId/schedules")
export class SchedulesController {
  constructor(@Inject(ScheduledTasksService) private readonly tasks: ScheduledTasksService) {}

  @Get()
  @OrgAction("schedules.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(ScheduleListQueryDto) q: z.infer<typeof ScheduleListQuery>,
  ): Promise<{ items: ScheduledTask[] }> {
    const p = requireUser(principal);
    const items = await this.tasks.list(
      org.orgId,
      { accountId: p.account.id, role: org.role },
      { all: q.all === "true" },
    );
    return { items };
  }

  @Post()
  @OrgAction("schedules.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ScheduleCreateBodyDto) body: z.infer<typeof ScheduleCreateBody>,
  ): Promise<{ task: ScheduledTask }> {
    const p = requireUser(principal);
    const { input, browserTimeZone } = createInputOf(body);
    return { task: await this.tasks.create(org.orgId, p.account.id, input, browserTimeZone) };
  }

  @Get(":id")
  @OrgAction("schedules.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
  ): Promise<{ task: ScheduledTask }> {
    const p = requireUser(principal);
    return {
      task: await this.tasks.get(org.orgId, { accountId: p.account.id, role: org.role }, params.id),
    };
  }

  @Patch(":id")
  @OrgAction("schedules.use")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
    @ZBody(ScheduleUpdateBodyDto) body: z.infer<typeof ScheduleUpdateBody>,
  ): Promise<{ task: ScheduledTask }> {
    const p = requireUser(principal);
    return {
      task: await this.tasks.update(org.orgId, p.account.id, params.id, updateInputOf(body)),
    };
  }

  @Delete(":id")
  @HttpCode(204)
  @OrgAction("org.read")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.tasks.remove(org.orgId, { accountId: p.account.id, role: org.role }, params.id);
  }

  @Post(":id/pause")
  @HttpCode(200)
  @OrgAction("org.read")
  async pause(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
  ): Promise<{ task: ScheduledTask }> {
    const p = requireUser(principal);
    return {
      task: await this.tasks.pause(
        org.orgId,
        { accountId: p.account.id, role: org.role },
        params.id,
      ),
    };
  }

  @Post(":id/resume")
  @HttpCode(200)
  @OrgAction("schedules.use")
  async resume(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
  ): Promise<{ task: ScheduledTask }> {
    const p = requireUser(principal);
    return {
      task: await this.tasks.resume(
        org.orgId,
        { accountId: p.account.id, role: org.role },
        params.id,
      ),
    };
  }

  @Post(":id/run")
  @HttpCode(202)
  @OrgAction("schedules.use")
  async run(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
    @ZBody(ScheduleRunBodyDto) body: z.infer<typeof ScheduleRunBody>,
  ): Promise<{ run: TaskRun }> {
    const p = requireUser(principal);
    return {
      run: await this.tasks.runNow(org.orgId, p.account.id, params.id, {
        trial: body.trial === true,
      }),
    };
  }

  @Get(":id/runs")
  @OrgAction("schedules.use")
  async runs(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
    @ZQuery(ScheduleRunsQueryDto) q: z.infer<typeof ScheduleRunsQuery>,
  ): Promise<{ items: TaskRun[] }> {
    const p = requireUser(principal);
    return {
      items: await this.tasks.runs(
        org.orgId,
        { accountId: p.account.id, role: org.role },
        params.id,
        q.limit,
      ),
    };
  }

  @Get(":id/grants")
  @OrgAction("schedules.use")
  async grants(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
  ): Promise<{ items: ScheduledTaskGrant[] }> {
    const p = requireUser(principal);
    return {
      items: await this.tasks.grants(
        org.orgId,
        { accountId: p.account.id, role: org.role },
        params.id,
      ),
    };
  }

  @Post(":id/grants")
  @HttpCode(200)
  @OrgAction("schedules.use")
  async addGrants(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleParamsDto) params: z.infer<typeof ScheduleParams>,
    @ZBody(ScheduleGrantsBodyDto) body: z.infer<typeof ScheduleGrantsBody>,
  ): Promise<{ items: ScheduledTaskGrant[] }> {
    const p = requireUser(principal);
    return {
      items: await this.tasks.addGrants(org.orgId, p.account.id, params.id, grantsOf(body.grants)),
    };
  }

  @Delete(":id/grants/:toolKey")
  @HttpCode(204)
  @OrgAction("schedules.use")
  async removeGrant(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ScheduleGrantParamsDto) params: z.infer<typeof ScheduleGrantParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.tasks.removeGrant(org.orgId, p.account.id, params.id, params.toolKey);
  }
}
