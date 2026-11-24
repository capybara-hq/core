import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { OwnedItems, type OwnedSkillDeletePreview } from "../catalog/owned-items.js";
import { isInlineArtifactType, isTextArtifactType } from "../conversations/artifacts.js";
import type { CreatedAttachment } from "../conversations/attachments.service.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { attachmentDisposition } from "../shares/share-open.service.js";
import { type SkillFileList, SkillFiles } from "./skill-files.js";
import {
  SkillCreateBody,
  SkillFileContentQuery,
  SkillFilesQuery,
  SkillIdParams,
  SkillShareableSchema,
  SkillUploadBody as UploadBody,
} from "./skills.schemas.js";
import {
  type SkillDetail,
  type SkillSummary,
  SkillsService,
  type UploadedSkill,
} from "./skills.service.js";

class SkillUploadBodyDto extends createZodDto(UploadBody, "SkillUploadBody") {}
class SkillCreateBodyDto extends createZodDto(SkillCreateBody, "SkillCreateBody") {}
const ShareableBody = SkillShareableSchema;
class SkillIdParamsDto extends createZodDto(SkillIdParams, "SkillIdParams") {}
class SkillShareableBody extends createZodDto(ShareableBody, "SkillShareableBody") {}
class SkillFilesQueryDto extends createZodDto(SkillFilesQuery, "SkillFilesQuery") {}
class SkillFileContentQueryDto extends createZodDto(
  SkillFileContentQuery,
  "SkillFileContentQuery",
) {}

/**
 * The org skill library (`/api/v1/orgs/:orgId/skills`, human users only):
 * - read: `skills.read` (member and up) — `GET /` list, `GET /:id` detail (versions and file
 *   lists), `GET /:id/files` a version's files and `GET /:id/files/content` one file's bytes;
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
    @Inject(SkillFiles) private readonly files: SkillFiles,
  ) {}

  @Post("uploads")
  @OrgAction("skills.manage")
  async createUpload(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(SkillUploadBodyDto) body: z.infer<typeof UploadBody>,
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
    return this.skills.upload(org.orgId, p.account.id, body.uploadId, tokenId, body.shareable);
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
  ): Promise<SkillDetail & { agentsOff: number }> {
    requireUser(principal);
    return this.skills.get(org.orgId, id);
  }

  /**
   * The files of a version of the skill (`?version=`, default the current one): `{ version, files:
   * { path, size, contentType, previewable }[] }`. Visibility as `GET /:id`; an unknown version →
   * 404 `skill.file_not_found`.
   */
  @Get(":id/files")
  @Header("cache-control", "private, no-store")
  @OrgAction("skills.read")
  async listFiles(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SkillIdParamsDto) params: z.infer<typeof SkillIdParams>,
    @ZQuery(SkillFilesQueryDto) q: z.infer<typeof SkillFilesQuery>,
  ): Promise<SkillFileList> {
    requireUser(principal);
    return this.files.list(org.orgId, params.id, q.version);
  }

  /**
   * One file's bytes (`?path=` a path of the version's manifest, `version=`, `limit=`, `inline=`),
   * checked against the manifest (409 `skill.file_changed`); unknown version or path → 404
   * `skill.file_not_found`. Never sniffed and sandboxed; `attachment` unless `inline=1` for a
   * raster image (HTML and SVG never inline). A text file is sent as `text/plain`, anything not
   * inline as `application/octet-stream`, the type by extension in `X-Content-Original-Type`;
   * `X-Content-Truncated: true` when `limit` cut it.
   */
  @Get(":id/files/content")
  @OrgAction("skills.read")
  async fileContent(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SkillIdParamsDto) params: z.infer<typeof SkillIdParams>,
    @ZQuery(SkillFileContentQueryDto) q: z.infer<typeof SkillFileContentQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    requireUser(principal);
    const { file, body, truncated } = await this.files.read(
      org.orgId,
      params.id,
      q.version,
      q.path,
      q.limit,
    );
    const inline = q.inline === "1" && isInlineArtifactType(file.contentType);
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    reply
      .header(
        "content-type",
        inline
          ? file.contentType
          : isTextArtifactType(file.contentType)
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
      )
      .header("x-content-original-type", file.contentType)
      .header("content-disposition", inline ? "inline" : attachmentDisposition(name))
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'");
    if (truncated) reply.header("x-content-truncated", "true");
    await reply.send(body);
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
