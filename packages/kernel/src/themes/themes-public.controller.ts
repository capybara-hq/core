import { Controller, Get, Header, Inject, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Public } from "../identity/principal.js";
import { ThemeDeliveryService } from "./theme-delivery.service.js";
import type { ThemeRef } from "./theme-state.js";
import { ThemesService } from "./themes.service.js";

/** A theme version's stylesheet and assets never change (the version is in the URL). */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Theme delivery (themes spec §8): every theme version's stylesheet and assets, public (styles are
 * not sensitive; the URLs reveal only that the theme exists) and immutable. The URLs are the ones
 * `themeUrl` builds; an unknown theme, version or file is 404 `theme.not_found`.
 */
@Controller("api/v1/themes/:id/:version")
export class ThemeDeliveryController {
  constructor(@Inject(ThemeDeliveryService) private readonly delivery: ThemeDeliveryService) {}

  /**
   * The version's stylesheet: scheme overrides, `@font-face` rules and font stacks, in the render
   * revision `revision` (`r<THEME_CSS_REVISION>`; only the current one is served). The URL without
   * a revision (before revision 2) has no route: 404, so a browser's cached unlayered copy is never
   * answered with the new format under an immutable cache.
   */
  @Public()
  @Get(":revision/theme.css")
  async css(
    @Param("id") id: string,
    @Param("version") version: string,
    @Param("revision") revision: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const css = await this.delivery.stylesheet(id, version, revision);
    await reply
      .header("content-type", "text/css; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", IMMUTABLE)
      .send(css);
  }

  /**
   * A font (`font/woff2`) or logo (`image/svg+xml`, sanitized at import, served under a CSP
   * sandbox; `image/png`) the version names; `file` is its plugin path as one segment
   * (`fonts%2FMiSans.woff2`).
   */
  @Public()
  @Get("assets/:file")
  async asset(
    @Param("id") id: string,
    @Param("version") version: string,
    @Param("file") file: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const a = await this.delivery.asset(id, version, file);
    reply
      .header("content-type", a.contentType)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", IMMUTABLE);
    if (a.contentType === "image/svg+xml") {
      reply.header("content-security-policy", "default-src 'none'; sandbox");
    }
    await reply.send(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength));
  }
}

/** The platform default theme for pages before sign-in (themes spec §8-§9), public. */
@Controller("api/v1/platform/theme")
export class PlatformThemeController {
  constructor(@Inject(ThemesService) private readonly themes: ThemesService) {}

  /** The platform default's reference while it is eligible; null: the built-in theme. */
  @Public()
  @Get()
  @Header("cache-control", "no-store")
  platformTheme(): Promise<ThemeRef | null> {
    return this.themes.platformDefault();
  }
}
