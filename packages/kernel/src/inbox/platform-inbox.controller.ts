import { Controller, Get, Inject } from "@nestjs/common";
import { SuperAdmin } from "../identity/principal.js";
import { PlatformInboxService, type PlatformInboxView } from "./platform-inbox.service.js";

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
}
