import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ATTACHMENT_DOWNLOAD_CACHE_SECONDS, AttachmentsService } from "./attachments.service.js";
import { DOWNLOAD_AS } from "./conversations.schemas.js";

// Not strict: the web adds a cache-busting `retry=1` when it reloads a failed image.
const DownloadQuery = z.object({ as: DOWNLOAD_AS.optional() });
class AttachmentDownloadQueryDto extends createZodDto(DownloadQuery, "AttachmentDownloadQuery") {}

/**
 * Attachment downloads (`/api/v1/orgs/:orgId/attachments`, `agents.use`, people only): `GET
 * /:id/download` redirects (302) to the presigned URL (`Cache-Control: private, max-age=60`) of a
 * `read` copy (an image a tool showed the agent); `?as=url` answers `{ url }`
 * with that address instead. Without an object store it answers 503 `storage.unavailable`. A
 * person's uploads go through the file library (`/files`).
 */
@Controller("api/v1/orgs/:orgId/attachments")
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Get(":id/download")
  @OrgAction("agents.use")
  async download(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZQuery(AttachmentDownloadQueryDto) q: z.infer<typeof DownloadQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const location = await this.attachments.downloadUrl(org.orgId, p.account.id, id);
    if (q.as === "url") {
      await reply.header("cache-control", "private, no-store").send({ url: location });
      return;
    }
    // 浏览器可在短时间内复用跳转（同一页面的缩略图）；预签名有效期不短于这段时间
    await reply
      .header("cache-control", `private, max-age=${ATTACHMENT_DOWNLOAD_CACHE_SECONDS}`)
      .redirect(location, 302);
  }
}
