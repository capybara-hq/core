import { Controller, Get, Header, Inject, Param, Put } from "@nestjs/common";
import { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  SkillFilePreviewersQuery,
  SkillFilePreviewParams,
  SkillFilePreviewQuery,
  SkillIdParams,
} from "../skills/skills.schemas.js";
import { type OrgPreviewerItem, type PreviewerItem, PreviewerRegistry } from "./previewers.js";
import { FilePreviewersOrderBody } from "./previewers.schemas.js";

const Id = z.string().min(1).max(100);
const PreviewQuery = z.object({ locale: z.enum(["zh", "en"]).default("en") });
const OrderBody = FilePreviewersOrderBody;
/** The previewer named in a preview path (the other path parameters are read as they are). */
const PreviewParams = z.object({ plugin: Id, previewerId: Id });

/** `…/files/:id/previewers` (a library file). */
const LibraryFileParams = z.object({ id: Id });
/** `…/files/:id/previews/:plugin/:previewerId` (a library file). */
const LibraryFilePreviewParams = LibraryFileParams.extend(PreviewParams.shape);

class LibraryFilePreviewersParamsDto extends createZodDto(
  LibraryFileParams,
  "LibraryFilePreviewersParams",
) {}
class LibraryFilePreviewParamsDto extends createZodDto(
  LibraryFilePreviewParams,
  "LibraryFilePreviewParams",
) {}
class FilePreviewQueryDto extends createZodDto(PreviewQuery, "FilePreviewQuery") {}
class FilePreviewParamsDto extends createZodDto(PreviewParams, "FilePreviewParams") {}
class FilePreviewersOrderBodyDto extends createZodDto(OrderBody, "FilePreviewersOrderBody") {}
class SkillFilePreviewersParamsDto extends createZodDto(
  SkillIdParams,
  "SkillFilePreviewersParams",
) {}
class SkillFilePreviewersQueryDto extends createZodDto(
  SkillFilePreviewersQuery,
  "SkillFilePreviewersQuery",
) {}
class SkillFilePreviewParamsDto extends createZodDto(
  SkillFilePreviewParams,
  "SkillFilePreviewParams",
) {}
class SkillFilePreviewQueryDto extends createZodDto(
  SkillFilePreviewQuery,
  "SkillFilePreviewQuery",
) {}

/**
 * `file-preview@1` (UI refresh B Task 11):
 * - `GET /api/v1/orgs/:orgId/conversations/:id/files/:fileId/previewers` → `{ previewers }`: the
 *   extension previewers that take this file version, in the org's order (viewer must read the
 *   conversation, otherwise 404);
 * - `GET .../files/:fileId/previews/:plugin/:previewerId?locale=` → `{ view }`: a view previewer's
 *   render (10 s → 504 `ui.timeout`, throws → 502 `ui.render_failed`, invalid → 502
 *   `ui.invalid_view`); an embed previewer gets its token from the ui embed-token route with
 *   `{ conversationId, fileId }` and the file over the message bridge;
 * - `GET /api/v1/orgs/:orgId/files/:id/previewers` and `GET .../files/:id/previews/:plugin/:previewerId`
 *   (file library spec §6): the same for one of the caller's own library files (anyone else's:
 *   404 `file.not_found`); args `source: "conversation"` without a `conversationId`; an embed
 *   previewer's token takes `{ fileId }` alone;
 * - `GET /api/v1/orgs/:orgId/skills/:id/files/previewers?version=&path=` and
 *   `GET .../skills/:id/files/previews/:plugin/:previewerId?version=&path=&locale=` (`skills.read`,
 *   skill file browser spec): the same for one file of a skill version, visibility as
 *   `GET /skills/:id` (404 `skill.not_found`, `skill.file_not_found`; a changed object 409
 *   `skill.file_changed`); an embed previewer's token takes `{ skillId, version, path }`;
 * - `GET / PUT /api/v1/orgs/:orgId/file-previewers` (`org.extensions.manage`) → `{ items }`: the
 *   org's order; PUT lists `{ plugin, id, disabled }` first-to-last, the rest follow.
 */
@Controller("api/v1/orgs/:orgId")
export class FilePreviewersController {
  constructor(@Inject(PreviewerRegistry) private readonly previewers: PreviewerRegistry) {}

  @Get("conversations/:id/files/:fileId/previewers")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async forFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
  ): Promise<{ previewers: PreviewerItem[] }> {
    const p = requireUser(principal);
    return { previewers: await this.previewers.forFile(org.orgId, id, p.account.id, fileId) };
  }

  @Get("conversations/:id/files/:fileId/previews/:plugin/:previewerId")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async preview(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
    @ZParam(FilePreviewParamsDto) { plugin, previewerId }: z.infer<typeof PreviewParams>,
    @ZQuery(FilePreviewQueryDto) q: z.infer<typeof PreviewQuery>,
  ) {
    const p = requireUser(principal);
    const view = await this.previewers.render({
      orgId: org.orgId,
      accountId: p.account.id,
      conversationId: id,
      fileId,
      plugin,
      id: previewerId,
      locale: q.locale,
    });
    return { view };
  }

  @Get("files/:id/previewers")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async forLibraryFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(LibraryFilePreviewersParamsDto) params: z.infer<typeof LibraryFileParams>,
  ): Promise<{ previewers: PreviewerItem[] }> {
    const p = requireUser(principal);
    return {
      previewers: await this.previewers.forFile(org.orgId, undefined, p.account.id, params.id),
    };
  }

  @Get("files/:id/previews/:plugin/:previewerId")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async previewLibraryFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(LibraryFilePreviewParamsDto) params: z.infer<typeof LibraryFilePreviewParams>,
    @ZQuery(FilePreviewQueryDto) q: z.infer<typeof PreviewQuery>,
  ) {
    const p = requireUser(principal);
    const view = await this.previewers.render({
      orgId: org.orgId,
      accountId: p.account.id,
      fileId: params.id,
      plugin: params.plugin,
      id: params.previewerId,
      locale: q.locale,
    });
    return { view };
  }

  @Get("skills/:id/files/previewers")
  @Header("cache-control", "private, no-store")
  @OrgAction("skills.read")
  async forSkillFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SkillFilePreviewersParamsDto) params: z.infer<typeof SkillIdParams>,
    @ZQuery(SkillFilePreviewersQueryDto) q: z.infer<typeof SkillFilePreviewersQuery>,
  ): Promise<{ previewers: PreviewerItem[] }> {
    requireUser(principal);
    return {
      previewers: await this.previewers.forSkillFile(org.orgId, params.id, q.version, q.path),
    };
  }

  @Get("skills/:id/files/previews/:plugin/:previewerId")
  @Header("cache-control", "private, no-store")
  @OrgAction("skills.read")
  async previewSkillFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(SkillFilePreviewParamsDto) params: z.infer<typeof SkillFilePreviewParams>,
    @ZQuery(SkillFilePreviewQueryDto) q: z.infer<typeof SkillFilePreviewQuery>,
  ) {
    const p = requireUser(principal);
    const view = await this.previewers.renderSkill({
      orgId: org.orgId,
      accountId: p.account.id,
      skillId: params.id,
      version: q.version,
      path: q.path,
      plugin: params.plugin,
      id: params.previewerId,
      locale: q.locale,
    });
    return { view };
  }

  @Get("file-previewers")
  @OrgAction("org.extensions.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ items: OrgPreviewerItem[] }> {
    return { items: await this.previewers.list(org.orgId) };
  }

  @Put("file-previewers")
  @OrgAction("org.extensions.manage")
  async put(
    @CurrentOrg() org: OrgContext,
    @CurrentPrincipal() principal: Principal,
    @ZBody(FilePreviewersOrderBodyDto) body: z.infer<typeof OrderBody>,
  ): Promise<{ items: OrgPreviewerItem[] }> {
    const actor =
      principal.kind === "service"
        ? { tokenId: principal.tokenId }
        : {
            accountId: principal.account.id,
            ...(principal.via === "pat" && { tokenId: principal.tokenId }),
          };
    return { items: await this.previewers.put(org.orgId, body.items, actor) };
  }
}
