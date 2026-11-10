import { Controller, Get, Inject } from "@nestjs/common";
import { SuperAdmin } from "../identity/principal.js";
import {
  type AdminAttention,
  AdminOverviewService,
  type AdminOverviewStats,
} from "./overview.service.js";

/**
 * The admin console overview (`/api/v1/admin/overview*`, admin overview spec §5.2): one read per
 * block, each failing on its own. Super admins only; service tokens 403; reads are not audited
 * (decision D5).
 */
@Controller("api/v1/admin/overview")
@SuperAdmin()
export class AdminOverviewController {
  constructor(@Inject(AdminOverviewService) private readonly overview: AdminOverviewService) {}

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
}
