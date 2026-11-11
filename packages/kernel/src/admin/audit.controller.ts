import { Controller, Get, Inject } from "@nestjs/common";
import type { z } from "zod";
import { SuperAdmin } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { AuditListQuery } from "./audit.schemas.js";
import { type PlatformAuditPage, PlatformAuditService } from "./platform-audit.service.js";

class AuditListQueryDto extends createZodDto(AuditListQuery, "AuditListQuery") {}

/**
 * The platform-level audit log (`GET /api/v1/admin/audit`, admin overview spec §5.2, decision D2):
 * events with no org, newest first, keyset paged; never an event's `detail`. Super admins only;
 * the read itself is not audited (D5).
 */
@Controller("api/v1/admin/audit")
@SuperAdmin()
export class AdminAuditController {
  constructor(@Inject(PlatformAuditService) private readonly audit: PlatformAuditService) {}

  /** `next` is the `after` of the next page, null at the end. */
  @Get()
  list(@ZQuery(AuditListQueryDto) q: z.infer<typeof AuditListQuery>): Promise<PlatformAuditPage> {
    return this.audit.list(q);
  }
}
