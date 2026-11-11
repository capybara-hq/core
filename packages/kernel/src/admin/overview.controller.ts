import { Controller, Get, Inject } from "@nestjs/common";
import type { z } from "zod";
import { SuperAdmin } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { type AdminHealth, AdminHealthService } from "./health.service.js";
import { UsageQuery } from "./overview.schemas.js";
import {
  type AdminAttention,
  AdminOverviewService,
  type AdminOverviewStats,
} from "./overview.service.js";
import { AdminUsageService, type AdminUsageWeek } from "./usage.service.js";

class UsageQueryDto extends createZodDto(UsageQuery, "AdminUsageQuery") {}

/**
 * The admin console overview (`/api/v1/admin/overview*`, admin overview spec §5.2): one read per
 * block, each failing on its own. Super admins only; service tokens 403; reads are not audited
 * (decision D5).
 */
@Controller("api/v1/admin/overview")
@SuperAdmin()
export class AdminOverviewController {
  constructor(
    @Inject(AdminOverviewService) private readonly overview: AdminOverviewService,
    @Inject(AdminHealthService) private readonly health: AdminHealthService,
    @Inject(AdminUsageService) private readonly usage: AdminUsageService,
  ) {}

  /** The numbers: orgs, accounts and everything waiting for a super admin. */
  @Get()
  stats(): Promise<AdminOverviewStats> {
    return this.overview.stats();
  }

  /** Extensions, plugin updates and model providers needing a look (reason categories only). */
  @Get("attention")
  attention(): Promise<AdminAttention> {
    return this.overview.attention();
  }

  /**
   * How the platform runs: live replicas by role, kernel queue counts, channel, device and sandbox
   * counts. Not cached; a source that does not answer is named in `unavailable`.
   */
  @Get("health")
  readHealth(): Promise<AdminHealth> {
    return this.health.read();
  }

  /**
   * Runs, tokens and estimated cost per calendar day in `tz` over today and the 6 days before,
   * and the top 10 orgs. Cached 300 s (Redis, every replica); a timeout is
   * `admin.usage_unavailable` (503).
   */
  @Get("usage")
  readUsage(@ZQuery(UsageQueryDto) q: z.infer<typeof UsageQuery>): Promise<AdminUsageWeek> {
    return this.usage.week(q.tz);
  }
}
