import { hasControlChars, MEDIA_NAME_MAX_CHARS } from "@capybara-hq/plugin-sdk";
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { OwnedItems, type OwnedSkillDeletePreview } from "../catalog/owned-items.js";
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
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { SkillCreateBody, SkillIdParams, SkillShareableSchema } from "./skills.schemas.js";
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
class SkillUploadBody extends createZodDto(UploadBody, "SkillUploadBody") {}
class SkillCreateBodyDto extends createZodDto(SkillCreateBody, "SkillCreateBody") {}
const ShareableBody = SkillShareableSchema;
class SkillIdParamsDto extends createZodDto(SkillIdParams, "SkillIdParams") {}
class SkillShareableBody extends createZodDto(ShareableBody, "SkillShareableBody") {}

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
 *   `DELETE /:id` soft-deletes (the web asks for confirmation, R3; `GET /:id/delete-preview` says
 *   what it does), `PUT /:id/shareable` sets 可共享 (plugin scope phase 3, ruling P3-6).
 * When the deployment setting `customSkills` is deny, registering an upload and creating both
 * return 403 `catalog.custom_disabled` (decided in the service, re-checked inside the org row lock
 * on create); installing skills from the platform catalog is unaffected.
 */
@Controller("api/v1/orgs/:orgId/skills")
export class SkillsController {
  constructor(
    @Inject(SkillsService) private readonly skills: SkillsService,
    /** The org's own items: 可共享 and the delete of a promoted skill (rulings P3-3, P3-19). */
    @Inject(OwnedItems) private readonly owned: OwnedItems,
  ) {}

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
    @ZBody(SkillCreateBodyDto) body: z.infer<typeof SkillCreateBody>,
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

  /**
   * Sets 可共享 on the org's own skill (`{ shareable }` -> 200 `{ id, shareable }`): only an org
   * skill of the org's own (P3-6: an agent's skill or a copy of another owner's platform skill ->
   * 409 `catalog.not_owned`); one it promoted writes its platform row too (ruling P3-2).
   */
  @Put(":id/shareable")
  @OrgAction("skills.manage")
  async setShareable(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SkillIdParamsDto) params: z.infer<typeof SkillIdParams>,
    @ZBody(SkillShareableBody) body: z.infer<typeof ShareableBody>,
  ): Promise<{ id: string; shareable: boolean }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    await this.owned.setShareable(
      org.orgId,
      p.account.id,
      { kind: "skill", id: params.id },
      body.shareable,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
    return { id: params.id, shareable: body.shareable };
  }

  /**
   * What deleting the skill does (pre-flight F19, P3-19; nothing written): `outcome`
   * `transferred` when it was shared and another org uses it (`orgs`), else `removed`; `agents`
   * the org's agents that lose it.
   */
  @Get(":id/delete-preview")
  @OrgAction("skills.manage")
  async deletePreview(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SkillIdParamsDto) params: z.infer<typeof SkillIdParams>,
  ): Promise<OwnedSkillDeletePreview> {
    requireUser(principal);
    return this.owned.previewSkillDelete(org.orgId, params.id);
  }

  /**
   * Soft-deletes the skill; one the org shared that another org uses is transferred to the
   * platform first (P3-19, platform notice `ownership_transferred`). 204.
   */
  @Delete(":id")
  @HttpCode(204)
  @OrgAction("skills.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<void> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    await this.owned.deleteSkill(
      org.orgId,
      p.account.id,
      id,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }
}
