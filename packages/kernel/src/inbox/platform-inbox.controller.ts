import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import {
  CurrentPrincipal,
  type Principal,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam } from "../infra/validation/zod-params.js";
import { PlatformInboxService, type PlatformInboxView } from "./platform-inbox.service.js";

const NoticeParamsSchema = z.object({ id: z.string().min(1).max(100) });
class NoticeParams extends createZodDto(NoticeParamsSchema, "PlatformInboxNoticeParams") {}

/**
 * The super admin's inbox (`GET /api/v1/admin/inbox`): the platform's requests, permission
 * confirmations, scope sync failures and the migration run that needs a look, newest first, at
 * most 100 (`truncated`: more, `total`: how many in all), and `GET /api/v1/admin/inbox/count`
 * (`{ total }`, the sidebar's count). Super admins only (web session or personal token).
 */
@Controller("api/v1/admin/inbox")
@SuperAdmin()
export class PlatformInboxController {
  constructor(@Inject(PlatformInboxService) private readonly inbox: PlatformInboxService) {}

  @Get()
  list(): Promise<PlatformInboxView> {
    return this.inbox.list();
  }

  @Get("count")
  async count(): Promise<{ total: number }> {
    return { total: await this.inbox.count() };
  }

  /** A super admin dismisses a platform notice (`ownership_transferred`) for every super admin. */
  @Post("notices/:id/dismiss")
  @HttpCode(204)
  async dismissNotice(
    @CurrentPrincipal() principal: Principal,
    @ZParam(NoticeParams) params: z.infer<typeof NoticeParamsSchema>,
  ): Promise<void> {
    await this.inbox.dismissNotice(requireUser(principal).account.id, params.id);
  }
}
