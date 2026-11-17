import { Controller, Get, Inject } from "@nestjs/common";
import type { z } from "zod";
import { SuperAdmin } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { AuditListQuery, OrgAuditListQuery } from "./audit.schemas.js";
import { AuditLogService, type AuditPage } from "./audit-log.service.js";

class AuditListQueryDto extends createZodDto(AuditListQuery, "AuditListQuery") {}
class OrgAuditListQueryDto extends createZodDto(OrgAuditListQuery, "OrgAuditListQuery") {}

/**
 * The platform-level audit log (`GET /api/v1/admin/audit`, admin overview spec §5.2, decision D2):
 * events with no org, or with `orgId` that org's, newest first, keyset paged; never an event's
 * `detail`. Super admins only; the read itself is not audited (D5).
 */
@Controller("api/v1/admin/audit")
@SuperAdmin()
export class AdminAuditController {
  constructor(@Inject(AuditLogService) private readonly audit: AuditLogService) {}

  /** `next` is the `after` of the next page, null at the end. */
  @Get()
  list(@ZQuery(AuditListQueryDto) q: z.infer<typeof AuditListQuery>): Promise<AuditPage> {
    const { orgId, ...page } = q;
    return this.audit.list(orgId === undefined ? { platform: true } : { orgId }, page);
  }
}

/**
 * The org's audit log (`GET /api/v1/orgs/:orgId/audit`): the org's own events, newest first,
 * keyset paged, the same rows as the platform log (never `detail`). Org admins (`org.update`, a
 * person: service tokens are refused); a non-member gets 404. The read is not audited.
 */
@Controller("api/v1/orgs/:orgId/audit")
export class OrgAuditController {
  constructor(@Inject(AuditLogService) private readonly audit: AuditLogService) {}

  /** `next` is the `after` of the next page, null at the end. */
  @Get()
  @OrgAction("org.update")
  list(
    @CurrentOrg() org: OrgContext,
    @ZQuery(OrgAuditListQueryDto) q: z.infer<typeof OrgAuditListQuery>,
  ): Promise<AuditPage> {
    return this.audit.list({ orgId: org.orgId }, q);
  }
}
