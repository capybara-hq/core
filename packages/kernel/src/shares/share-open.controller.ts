import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FILE_CONTENT_MAX_BYTES } from "../conversations/files.js";
import { Public } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { type ShareMeta, ShareOpenService } from "./share-open.service.js";

/** `GET /api/v1/s/:code/content`: `download=1` adds `content-disposition: attachment`. */
export const ShareContentQuery = z.object({ download: z.enum(["0", "1"]).optional() });
/** `GET /api/v1/s/:code/text`: at most this many bytes (≤ 1 MiB, the panel's text route). */
export const ShareTextQuery = z.object({
  limit: z.coerce.number().int().min(1).max(FILE_CONTENT_MAX_BYTES).default(FILE_CONTENT_MAX_BYTES),
});

class ShareContentQueryDto extends createZodDto(ShareContentQuery, "ShareContentQuery") {}
class ShareTextQueryDto extends createZodDto(ShareTextQuery, "ShareTextQuery") {}

/**
 * The public share link routes (file sharing spec §3), all `@Public()` under `/api/v1/s/:code`:
 * metadata, the snapshot's bytes, its text, a bitmap inline, and the redirect to its HTML
 * document. The code is not validated by a pipe: a malformed code is a miss like an unknown one
 * (counted by the `share-open` throttler, 404 `share.not_found`). Every check is
 * {@link ShareOpenService.open}'s.
 */
@Controller("api/v1/s/:code")
export class ShareOpenController {
  constructor(@Inject(ShareOpenService) private readonly shares: ShareOpenService) {}

  /** The share's metadata; the open is audited (`share.opened`). */
  @Public()
  @Get()
  async meta(
    @Param("code") code: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ShareMeta> {
    const opened = await this.shares.open(code, req, reply);
    return this.shares.meta(opened, req.ip);
  }

  /** The snapshot's bytes, always `application/octet-stream` under the sandbox CSP. */
  @Public()
  @Get("content")
  async content(
    @Param("code") code: string,
    @ZQuery(ShareContentQueryDto) q: z.infer<typeof ShareContentQuery>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { share } = await this.shares.open(code, req, reply);
    await this.shares.content(share, q.download === "1", reply);
  }

  /** The first bytes of a text snapshot as `text/plain; charset=utf-8`. */
  @Public()
  @Get("text")
  async text(
    @Param("code") code: string,
    @ZQuery(ShareTextQueryDto) q: z.infer<typeof ShareTextQuery>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { share } = await this.shares.open(code, req, reply);
    await this.shares.text(share, q.limit, reply);
  }

  /** A bitmap snapshot with its own type (png, jpeg, gif, webp); any other type → 404. */
  @Public()
  @Get("inline")
  async inline(
    @Param("code") code: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { share } = await this.shares.open(code, req, reply);
    await this.shares.inline(share, reply);
  }

  /** 302 to the HTML document with a fresh share token (`cache-control: no-store`). */
  @Public()
  @Get("html")
  async html(
    @Param("code") code: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { share } = await this.shares.open(code, req, reply);
    const { path } = this.shares.htmlPath(share);
    await reply.header("cache-control", "no-store").redirect(path, 302);
  }
}
