import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { ARTIFACT_DOWNLOAD_CACHE_SECONDS } from "../conversations/artifacts.js";
import { DOWNLOAD_AS } from "../conversations/conversations.schemas.js";
import { FILE_CONTENT_MAX_BYTES } from "../conversations/files.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { Throttled } from "../infra/throttler/throttler.guard.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { FileCreateBody, FileIdParams, LibraryListQuery } from "./library.schemas.js";
import {
  type CreatedFile,
  type FileLimits,
  type FileView,
  LibraryFilesService,
} from "./library-files.service.js";
import {
  type LibraryFileDetails,
  type LibraryFileView,
  LibraryQuery,
  type LibraryUsage,
} from "./library-query.js";

const ContentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(FILE_CONTENT_MAX_BYTES).default(FILE_CONTENT_MAX_BYTES),
});
/**
 * `inline=1`: open inline (bitmaps only); `as=url`: answer `{ url }` instead of redirecting. Not
 * strict: the web adds a cache-busting `retry=1` when it reloads a failed image.
 */
const DownloadQuery = z.object({
  inline: z.enum(["0", "1"]).optional(),
  as: DOWNLOAD_AS.optional(),
});

class FileCreateBodyDto extends createZodDto(FileCreateBody, "FileCreateBody") {}
class LibraryListQueryDto extends createZodDto(LibraryListQuery, "LibraryListQuery") {}
class FileIdParamsDto extends createZodDto(FileIdParams, "FileIdParams") {}
class LibraryFileContentQueryDto extends createZodDto(ContentQuery, "LibraryFileContentQuery") {}
class LibraryFileDownloadQueryDto extends createZodDto(DownloadQuery, "LibraryFileDownloadQuery") {}

/**
 * The person's files (`/api/v1/orgs/:orgId/files`, `agents.use`, people only; file library spec
 * §3):
 * 1. `POST /` with `{ name, contentType, size, sha256, purpose }` → 201 `{ file, upload,
 *    expiresAt }`: `upload` is a presigned form (`method` `POST`: the `fields` first, the `file`
 *    last), or null when the caller already holds these bytes (the file exists at once);
 * 2. the browser sends the bytes to the store;
 * 3. `POST /:id/finalize` → `{ id, name, contentType, size, status }`;
 * 4. a message names the id in `files`.
 * Finalize is limited to 60 a minute per person (429 `rate_limited`). `DELETE /:id/draft` (204)
 * drops a composer upload before it is sent; `GET /limits` answers the types, sizes, files per
 * message, the media budget per request and whether storage is available (no object store
 * needed). Without an object store the upload routes answer 503 `storage.unavailable`.
 *
 * The library (file library spec §6, §8; the caller's own files only: another account's file is
 * 404 `file.not_found` on every route; `Cache-Control: private, no-store`):
 * - `GET /?origin=&agentId=&type=&q=&limit=&cursor=` → `{ files, next }`: ready files newest first,
 *   the deliveries of one source path in one conversation collapsed to the newest with `versions`;
 *   `q` a case-insensitive substring of the name (the composer's `@` search);
 * - `GET /usage` → `{ bytes, files }`; `GET /:id` → `{ file, conversations, versions }`;
 * - `GET /:id/content?limit=` and `GET /:id/download?as=url&inline=1`: the conversation-scoped
 *   routes' twins (same headers; the download a 302 with `private, max-age=60`);
 * - `DELETE /:id` (204): the file is deleted and its shares revoked.
 */
@Controller("api/v1/orgs/:orgId/files")
export class LibraryFilesController {
  constructor(
    @Inject(LibraryFilesService) private readonly files: LibraryFilesService,
    @Inject(LibraryQuery) private readonly library: LibraryQuery,
  ) {}

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
  @Throttled("file-finalize")
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

  @Get()
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(LibraryListQueryDto) q: z.infer<typeof LibraryListQuery>,
  ): Promise<{ files: LibraryFileView[]; next: string | null }> {
    const p = requireUser(principal);
    return this.library.list(org.orgId, p.account.id, {
      limit: q.limit,
      ...(q.origin !== undefined && { origin: q.origin }),
      ...(q.agentId !== undefined && { agentId: q.agentId }),
      ...(q.type !== undefined && { type: q.type }),
      ...(q.q !== undefined && { q: q.q }),
      ...(q.cursor !== undefined && { cursor: q.cursor }),
    });
  }

  @Get("usage")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async usage(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<LibraryUsage> {
    const p = requireUser(principal);
    return this.library.usage(org.orgId, p.account.id);
  }

  @Get(":id")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async details(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(FileIdParamsDto) params: z.infer<typeof FileIdParams>,
  ): Promise<LibraryFileDetails> {
    const p = requireUser(principal);
    return this.library.details(org.orgId, p.account.id, params.id);
  }

  /**
   * The first `limit` bytes (≤ 1 MiB) of a text file, always as `text/plain; charset=utf-8` with
   * the stored type in `X-Content-Original-Type` (sandboxed, never sniffed);
   * `X-Content-Truncated: true` when cut. Not text → 400 `conversation.artifact_not_previewable`;
   * bytes gone → 410 `file.deleted`.
   */
  @Get(":id/content")
  @OrgAction("agents.use")
  async content(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(FileIdParamsDto) params: z.infer<typeof FileIdParams>,
    @ZQuery(LibraryFileContentQueryDto) q: z.infer<typeof ContentQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const c = await this.library.content(org.orgId, p.account.id, params.id, q.limit);
    reply
      .header("content-type", c.contentType)
      .header("x-content-original-type", c.originalType)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'");
    if (c.truncated) reply.header("x-content-truncated", "true");
    await reply.send(c.body);
  }

  /**
   * A 302 to the presigned address of the file's bytes (`attachment` with its name; `inline=1`
   * only for bitmaps), `Cache-Control: private, max-age=60`; `as=url` answers `{ url }` instead
   * (never cached).
   */
  @Get(":id/download")
  @OrgAction("agents.use")
  async download(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(FileIdParamsDto) params: z.infer<typeof FileIdParams>,
    @ZQuery(LibraryFileDownloadQueryDto) q: z.infer<typeof DownloadQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const { url } = await this.library.downloadUrl(org.orgId, p.account.id, params.id, {
      inline: q.inline === "1",
    });
    if (q.as === "url") {
      await reply.header("cache-control", "private, no-store").send({ url });
      return;
    }
    await reply
      .header("cache-control", `private, max-age=${ARTIFACT_DOWNLOAD_CACHE_SECONDS}`)
      .redirect(url, 302);
  }

  @Delete(":id")
  @HttpCode(204)
  @OrgAction("agents.use")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(FileIdParamsDto) params: z.infer<typeof FileIdParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.files.delete(org.orgId, p.account.id, params.id);
  }
}
