import {
  hasControlChars,
  isSkillName,
  MEDIA_NAME_MAX_CHARS,
  SKILL_LIMITS,
} from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import {
  type CreatedAttachment,
  SKILL_PACKAGE_UPLOAD_MAX_BYTES,
} from "../conversations/attachments.service.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { SKILL_WRITE_MAX_BYTES } from "../tools/builtins/skill-write.js";
import {
  type SkillDetail,
  type SkillSummary,
  SkillsService,
  type UploadedSkill,
} from "./skills.service.js";

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
const CreateBody = z
  .object({
    uploadId: z.string().min(1).max(100).optional(),
    name: z
      .string()
      .refine(isSkillName, "name must be 1-64 lowercase letters, digits and single hyphens")
      .optional(),
    description: z.string().min(1).max(SKILL_LIMITS.descriptionMaxChars).optional(),
    body: z.string().max(SKILL_WRITE_MAX_BYTES).optional(),
    shareable: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.uploadId !== undefined
        ? v.name === undefined && v.description === undefined && v.body === undefined
        : v.name !== undefined && v.description !== undefined && v.body !== undefined,
    "send either { uploadId } or { name, description, body }",
  );
class SkillUploadBody extends createZodDto(UploadBody, "SkillUploadBody") {}
class SkillCreateBody extends createZodDto(CreateBody, "SkillCreateBody") {}

/**
 * The org skill library (`/api/v1/orgs/:orgId/skills`, human users only):
 * - read: `skills.read` (member and up) — `GET /` list, `GET /:id` detail (versions and file
 *   lists);
 * - write: `skills.manage` (admin and up) —
 *   1. `POST /uploads` registers a skill package upload (`application/zip`, ≤ 50MB, returns a
 *      presigned form, used like chat attachments);
 *   2. the browser uploads straight to object storage (it may call
 *      `POST /attachments/:id/finalize`, or skip it and let the next step finalize);
 *   3. `POST /` `{ uploadId }` unpacks and checks it, creating a skill or adding a version to the
 *      skill with the same name;
 *   `DELETE /:id` soft-deletes (the web asks for confirmation, R3).
 * When the deployment setting `customSkills` is deny, registering an upload and creating both
 * return 403 `catalog.custom_disabled` (decided in the service, re-checked inside the org row lock
 * on create); installing skills from the platform catalog is unaffected.
 */
@Controller("api/v1/orgs/:orgId/skills")
export class SkillsController {
  constructor(@Inject(SkillsService) private readonly skills: SkillsService) {}

  @Post("uploads")
  @OrgAction("skills.manage")
  async createUpload(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(SkillUploadBody) body: z.infer<typeof UploadBody>,
  ): Promise<CreatedAttachment> {
    const p = requireUser(principal);
    return this.skills.createUpload(org.orgId, p.account.id, body);
  }

  @Post()
  @OrgAction("skills.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(SkillCreateBody) body: z.infer<typeof CreateBody>,
  ): Promise<UploadedSkill> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    if (body.uploadId !== undefined) {
      return this.skills.upload(org.orgId, p.account.id, body.uploadId, tokenId, body.shareable);
    }
    return this.skills.createFromText(org.orgId, p.account.id, {
      name: body.name as string,
      description: body.description as string,
      body: body.body as string,
      ...(body.shareable !== undefined && { shareable: body.shareable }),
      ...(tokenId !== undefined && { actorTokenId: tokenId }),
    });
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
