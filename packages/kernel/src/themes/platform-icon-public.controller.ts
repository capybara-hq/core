import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { Public } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { PlatformIconParams, PlatformIconQuery } from "./platform-icon.schemas.js";
import { PlatformIconService } from "./platform-icon.service.js";

class PlatformIconPublicParamsDto extends createZodDto(
  PlatformIconParams,
  "PlatformIconPublicParams",
) {}
class PlatformIconQueryDto extends createZodDto(PlatformIconQuery, "PlatformIconQuery") {}

/** With the current hash in `v` the URL's bytes never change. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The platform icon's bytes (mobile layout spec §10.2.1), public: the PWA manifest, the favicons
 * and native clients read it before sign-in, and an icon is not sensitive. `?v=<sha256>` (the URL
 * the settings list) is cached as immutable; without `v` the response is revalidated; a `v` that is
 * not the current hash, or a purpose with no upload, is 404 `platform_icon.not_found` (the web then
 * uses its built-in icon). The type is fixed by the purpose, with `nosniff`; the SVG favicon also
 * gets a sandbox CSP, so opened directly it runs nothing and loads nothing.
 */
@Controller("api/v1/platform/icon")
export class PlatformIconPublicController {
  constructor(@Inject(PlatformIconService) private readonly icons: PlatformIconService) {}

  @Public()
  @Get(":purpose")
  async icon(
    @ZParam(PlatformIconPublicParamsDto) { purpose }: z.infer<typeof PlatformIconParams>,
    @ZQuery(PlatformIconQueryDto) { v }: z.infer<typeof PlatformIconQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const icon = await this.icons.read(purpose, v);
    reply
      .header("content-type", icon.contentType)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", icon.immutable ? IMMUTABLE : "no-cache");
    if (icon.contentType === "image/svg+xml") {
      reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    }
    await reply.send(Buffer.from(icon.bytes.buffer, icon.bytes.byteOffset, icon.bytes.byteLength));
  }
}
