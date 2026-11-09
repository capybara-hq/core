import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { ClientAccess } from "./client-access.service.js";

/** The route prefix, as the raw request path starts with it. */
const PREFIX = "/api/v1/client/";

/** A build's files never change (the package sha256 is in the URL); only its viewers may cache them. */
const IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable";

/**
 * Client file delivery (client extensions spec §9.3): `GET /api/v1/client/<plugin>/<build>/<path>`
 * serves the entry, a stylesheet or an asset of a client build to a signed-in person allowed to load
 * it ({@link ClientAccess.file}: one PG query per request, nothing cached); anything else is 404
 * `client.not_found`. The web's document CSP allows scripts from this prefix only, so the route
 * never redirects (no trailing-slash or case redirect either): a redirect would leave the path the
 * policy checked.
 *
 * The file is named by the raw request path, never by the decoded wildcard parameter: the path is
 * matched segment by segment against the manifest key's charset, so `..`, encoded separators and
 * backslashes name nothing.
 *
 * Headers: `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`,
 * `Cross-Origin-Resource-Policy: same-origin`, the content type of the file's kind
 * (`text/javascript`, `text/css; charset=utf-8`, the asset type), and for an SVG asset
 * `Content-Security-Policy: default-src 'none'; sandbox`.
 */
@Controller("api/v1/client")
export class ClientDeliveryController {
  constructor(@Inject(ClientAccess) private readonly access: ClientAccess) {}

  @Get(":plugin/:build/*")
  async file(
    @CurrentPrincipal() principal: Principal,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const raw = req.raw.url ?? "";
    const q = raw.indexOf("?");
    const path = q < 0 ? raw : raw.slice(0, q);
    const f = await this.access.file(
      p.account.id,
      p.account.isSuperAdmin,
      path.startsWith(PREFIX) ? path.slice(PREFIX.length) : "",
    );
    reply
      .header("content-type", f.contentType)
      .header("cache-control", IMMUTABLE_PRIVATE)
      .header("x-content-type-options", "nosniff")
      .header("cross-origin-resource-policy", "same-origin");
    if (f.contentType === "image/svg+xml") {
      reply.header("content-security-policy", "default-src 'none'; sandbox");
    }
    await reply.send(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength));
  }
}
