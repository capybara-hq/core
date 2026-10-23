import { hasControlChars, MEDIA_NAME_MAX_CHARS } from "@capybara-hq/plugin-sdk";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import {
  type CreatedAttachment,
  SKILL_PACKAGE_UPLOAD_MAX_BYTES,
} from "../conversations/attachments.service.js";
import { SKILLS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { SkillDetail, SkillSummary, SkillsService, UploadedSkill } from "./skills.service.js";

const UploadBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MEDIA_NAME_MAX_CHARS)
      .refine((s) => !hasControlChars(s), "name must not contain control characters"),
    size: z.number().int().min(1).max(SKILL_PACKAGE_UPLOAD_MAX_BYTES),
  })
  .strict();
const CreateBody = z.object({ uploadId: z.string().min(1).max(100) }).strict();

/**
 * 组织技能库（`/api/v1/orgs/:orgId/skills`，只接受人类用户）：
 * - 读：`skills.read`（member 以上）——`GET /` 列表，`GET /:id` 详情（各版本与文件清单）；
 * - 写：`skills.manage`（admin 以上）——
 *   1. `POST /uploads` 登记技能包上传（`application/zip`，≤ 50MB，返回预签名表单，用法同对话附件）；
 *   2. 浏览器直传对象存储（可再调 `POST /attachments/:id/finalize`，也可省略，由下一步代为 finalize）；
 *   3. `POST /` `{ uploadId }` 解包校验，创建技能或给同名技能新增一个版本；
 *   `DELETE /:id` 软删除（二次确认由网页负责，R3）。
 * 部署设置 `customSkills` 为 deny 时，上传登记与创建都返回 403 `directory.custom_disabled`（服务里判定，
 * 创建时在组织行锁内复核）；从企业目录安装技能不受影响。
 */
@Controller("api/v1/orgs/:orgId/skills")
export class SkillsController {
  constructor(@Inject(SKILLS) private readonly skills: SkillsService) {}

  @Post("uploads")
  @OrgAction("skills.manage")
  async createUpload(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(UploadBody)) body: z.infer<typeof UploadBody>,
  ): Promise<CreatedAttachment> {
    const p = requireUser(principal);
    return this.skills.createUpload(org.orgId, p.account.id, body);
  }

  @Post()
  @OrgAction("skills.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<UploadedSkill> {
    const p = requireUser(principal);
    return this.skills.upload(org.orgId, p.account.id, body.uploadId, patTokenId(p));
  }

  @Get()
  @OrgAction("skills.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ skills: SkillSummary[] }> {
    requireUser(principal);
    return { skills: await this.skills.list(org.orgId) };
  }

  @Get(":id")
  @OrgAction("skills.read")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<SkillDetail> {
    requireUser(principal);
    return this.skills.get(org.orgId, id);
  }

  @Delete(":id")
  @HttpCode(204)
  @OrgAction("skills.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.skills.softDelete(org.orgId, id, p.account.id, patTokenId(p));
  }
}
