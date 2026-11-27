import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { FileCreateBody } from "./library.schemas.js";
import {
  type CreatedFile,
  type FileLimits,
  type FileView,
  LibraryFilesService,
} from "./library-files.service.js";

class FileCreateBodyDto extends createZodDto(FileCreateBody, "FileCreateBody") {}

/**
 * The person's files (`/api/v1/orgs/:orgId/files`, `agents.use`, people only; file library spec
 * §3):
 * 1. `POST /` with `{ name, contentType, size, sha256, purpose }` → 201 `{ file, upload,
 *    expiresAt }`: `upload` is a presigned form (`method` `POST`: the `fields` first, the `file`
 *    last), or null when the caller already holds these bytes (the file exists at once);
 * 2. the browser sends the bytes to the store;
 * 3. `POST /:id/finalize` → `{ id, name, contentType, size, status }`;
 * 4. a message names the id in `files`.
 * `DELETE /:id/draft` (204) drops a composer upload before it is sent; `GET /limits` answers the
 * types, sizes, files per message, the media budget per request and whether storage is available
 * (no object store needed). Without an object store the upload routes answer 503
 * `storage.unavailable`.
 */
@Controller("api/v1/orgs/:orgId/files")
export class LibraryFilesController {
  constructor(@Inject(LibraryFilesService) private readonly files: LibraryFilesService) {}

  @Get("limits")
  @OrgAction("agents.use")
  limits(@CurrentPrincipal() principal: Principal): FileLimits {
    requireUser(principal);
    return this.files.limits();
  }

  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(FileCreateBodyDto) body: z.infer<typeof FileCreateBody>,
  ): Promise<CreatedFile> {
    const p = requireUser(principal);
    return this.files.create(org.orgId, p.account.id, body);
  }

  @Post(":id/finalize")
  @HttpCode(200)
  @OrgAction("agents.use")
  async finalize(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<FileView> {
    const p = requireUser(principal);
    return this.files.finalize(org.orgId, p.account.id, id);
  }

  @Delete(":id/draft")
  @HttpCode(204)
  @OrgAction("agents.use")
  async discard(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.files.discard(org.orgId, p.account.id, id);
  }
}
