import type { UiView } from "@capybara-hq/plugin-sdk";
import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { PreviewerRegistry } from "../files/previewers.js";
import { Public } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { EMBED_TOKEN_TTL_SECONDS, EmbedTokens } from "../ui/embed-token.js";
import { embedSrc } from "../ui/views.controller.js";
import { UiViews } from "../ui/views.js";
import { ShareOpenService } from "./share-open.service.js";

/** `GET /api/v1/s/:code/previews/:plugin/:previewerId`: the locale the view is rendered in. */
export const SharePreviewQuery = z.object({ locale: z.enum(["zh", "en"]).default("en") });

class SharePreviewQueryDto extends createZodDto(SharePreviewQuery, "SharePreviewQuery") {}

/** What the share embed-token route answers (the web's `ShareEmbedToken`). */
export interface ShareEmbedTokenResponse {
  token: string;
  /** `/plugin-ui/<plugin>/<path without the leading /ui/>`. */
  src: string;
  /** Seconds; the page renews from the moment it received it. */
  expiresIn: number;
}

const previewerNotFound = () => new ApiError("ui.not_found", "Previewer not found");

/**
 * Extension previewers on a share page (file sharing spec §3, §7), `@Public()` under
 * `/api/v1/s/:code`: every route opens the share first ({@link ShareOpenService.open}: the
 * `share-open` throttler, 404 `share.not_found` for every refusal, 401 `share.sign_in_required`
 * for an internal share without a member's session), so the link stays the only authority.
 * - `POST .../embed-token/:plugin/:previewerId` → `{ token, src, expiresIn }`: a share-scoped
 *   embed token (`scope: "share"`, the share's org, id and generation, no account or role) for an
 *   embed previewer that takes the snapshot in the org's order; a view previewer, one that does not
 *   take the snapshot or is off → 404 `ui.not_found`. The token is checked live on every use
 *   (`ctx.ui.verifyEmbedToken`) and never valid for `/api`. Unsafe: the CSRF header is required.
 * - `GET .../previews/:plugin/:previewerId?locale=` → `{ view }`: a view previewer rendered for
 *   the snapshot (`source: "share"`); errors as the panel's preview route (404 `ui.not_found`,
 *   502 `ui.render_failed`, 502 `ui.invalid_view`, 504 `ui.timeout`).
 * The plugin and previewer ids are matched, not validated, so a malformed one is a 404 after the
 * open like an unknown one.
 */
@Controller("api/v1/s/:code")
export class SharePreviewsController {
  constructor(
    @Inject(ShareOpenService) private readonly shares: ShareOpenService,
    @Inject(PreviewerRegistry) private readonly previewers: PreviewerRegistry,
    @Inject(UiViews) private readonly views: UiViews,
    @Inject(EmbedTokens) private readonly embeds: EmbedTokens,
  ) {}

  @Public()
  @Post("embed-token/:plugin/:previewerId")
  @HttpCode(200)
  async embedToken(
    @Param("code") code: string,
    @Param("plugin") plugin: string,
    @Param("previewerId") previewerId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ShareEmbedTokenResponse> {
    const { share } = await this.shares.open(code, req, reply);
    const target = await this.previewers.shareEmbed(share.orgId, share, plugin, previewerId);
    if (target === null) throw previewerNotFound();
    const path = this.views.shareEmbedPath(plugin, target.contribution);
    const { token } = this.embeds.issue({
      plugin,
      scope: "share",
      orgId: share.orgId,
      shareId: share.id,
      generation: share.generation,
      contribution: target.contribution,
    });
    return { token, src: embedSrc(plugin, path), expiresIn: EMBED_TOKEN_TTL_SECONDS };
  }

  @Public()
  @Get("previews/:plugin/:previewerId")
  async preview(
    @Param("code") code: string,
    @Param("plugin") plugin: string,
    @Param("previewerId") previewerId: string,
    @ZQuery(SharePreviewQueryDto) q: z.infer<typeof SharePreviewQuery>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ view: UiView }> {
    const { share } = await this.shares.open(code, req, reply);
    const view = await this.previewers.renderShare({
      orgId: share.orgId,
      shareId: share.id,
      file: share,
      plugin,
      id: previewerId,
      locale: q.locale,
    });
    return { view };
  }
}
