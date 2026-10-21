import { hasControlChars, MEDIA_NAME_MAX_CHARS } from "@capybara-hq/plugin-sdk";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { ATTACHMENTS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  ATTACHMENT_DOWNLOAD_CACHE_SECONDS,
  type AttachmentLimits,
  type AttachmentsService,
  type AttachmentView,
  type CreatedAttachment,
} from "./attachments.service.js";

const CreateBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MEDIA_NAME_MAX_CHARS)
      .refine((s) => !hasControlChars(s), "name must not contain control characters"),
    contentType: z.string().min(1).max(200),
    size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * 对话附件（`/api/v1/orgs/:orgId/attachments`，`agents.use`，只接受人类用户）：
 * 1. `POST /` 登记并取预签名上传（`upload.method` 为 `POST` 时按 multipart 表单：先放 `fields`，最后放 `file`）；
 * 2. 浏览器直传对象存储；
 * 3. `POST /:id/finalize` 核对大小与类型；
 * 4. 发消息时在 `files` 里引用 id。
 * 下载 `GET /:id/download` 302 到预签名地址（`Cache-Control: private, max-age=60`）。上限 `GET /limits`（类型、单个大小、
 * 每条条数、单次请求的媒体预算、存储是否可用，供网页预检；不需要对象存储）。没有对象存储时其余接口 503 `storage.unavailable`。
 */
@Controller("api/v1/orgs/:orgId/attachments")
export class AttachmentsController {
  constructor(@Inject(ATTACHMENTS) private readonly attachments: AttachmentsService) {}

  @Get("limits")
  @OrgAction("agents.use")
  limits(@CurrentPrincipal() principal: Principal): AttachmentLimits {
    requireUser(principal);
    return this.attachments.limits();
  }

  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<CreatedAttachment> {
    const p = requireUser(principal);
    return this.attachments.create(org.orgId, p.account.id, body);
  }

  @Post(":id/finalize")
  @HttpCode(200)
  @OrgAction("agents.use")
  async finalize(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<AttachmentView> {
    const p = requireUser(principal);
    return this.attachments.finalize(org.orgId, p.account.id, id);
  }

  @Get(":id/download")
  @OrgAction("agents.use")
  async download(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const location = await this.attachments.downloadUrl(org.orgId, p.account.id, id);
    // 浏览器可在短时间内复用跳转（同一页面的缩略图）；预签名有效期不短于这段时间
    await reply
      .header("cache-control", `private, max-age=${ATTACHMENT_DOWNLOAD_CACHE_SECONDS}`)
      .redirect(location, 302);
  }
}
