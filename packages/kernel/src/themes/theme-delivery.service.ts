import { isThemeAssetPath, type ParsedTheme } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { packagePath } from "../packages/tgz.js";
import { StorageService } from "../storage/storage.service.js";
import { renderThemeCss } from "./render-css.js";
import { themeUrl } from "./theme-state.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A version number as it appears in a delivery URL: a positive int4. */
const VERSION_RE = /^[1-9]\d{0,9}$/;
const INT4_MAX = 2_147_483_647;

/** The content type of each asset kind a theme names (fonts and logos). */
const ASSET_TYPES: readonly [RegExp, string][] = [
  [/\.woff2$/i, "font/woff2"],
  [/\.svg$/i, "image/svg+xml"],
  [/\.png$/i, "image/png"],
];

/** A theme asset's bytes and content type. */
export interface ThemeAsset {
  contentType: string;
  data: Uint8Array;
}

/** 404 `theme.not_found`. */
const notFound = (what: string): ApiError =>
  new ApiError(
    "theme.not_found",
    `${what} does not exist; reload the page to get the current theme`,
  );

/**
 * Delivery of theme versions (themes spec §8): the stylesheet rendered from the stored definition
 * and the stored assets. A version is identified by the theme id and version number only; a theme
 * removed later (soft-deleted) still serves its versions, because their URLs are immutable and may
 * be cached in open pages, and a theme's styles are not sensitive (§8, public access).
 */
@Injectable()
export class ThemeDeliveryService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** The stored version row, or 404 `theme.not_found`. */
  private async version(
    id: string,
    version: string,
  ): Promise<{ definition: ParsedTheme; objectPrefix: string | null }> {
    if (!UUID_RE.test(id) || !VERSION_RE.test(version) || Number(version) > INT4_MAX) {
      throw notFound(`Theme ${id} version ${version}`);
    }
    const row = await this.db
      .selectFrom("platform_theme_versions")
      .select(["definition", "object_prefix"])
      .where("theme_id", "=", id)
      .where("version", "=", Number(version))
      .executeTakeFirst();
    if (!row) throw notFound(`Theme ${id} version ${version}`);
    return { definition: row.definition as ParsedTheme, objectPrefix: row.object_prefix };
  }

  /**
   * The stylesheet of version `version` of theme `id` ({@link renderThemeCss}, asset URLs from
   * {@link themeUrl}); a stored value that fails re-validation is left out with one warning per
   * render naming every skipped value. Unknown theme or version: 404 `theme.not_found`.
   */
  async stylesheet(id: string, version: string): Promise<string> {
    const { definition } = await this.version(id, version);
    return renderThemeCss(
      definition,
      (path) => themeUrl(id, version, path),
      (skipped) =>
        this.log.warn("theme stylesheet: stored values failed re-validation and were left out", {
          themeId: id,
          version,
          skipped,
        }),
    );
  }

  /**
   * Asset `file` (a path inside the plugin, as stored: `fonts/MiSans.woff2`) of version `version`
   * of theme `id`: only a font or logo the version's definition names. Unknown theme, version or
   * file: 404 `theme.not_found`.
   */
  async asset(id: string, version: string, file: string): Promise<ThemeAsset> {
    const v = await this.version(id, version);
    const def = v.definition;
    const named = [
      ...(Array.isArray(def.fonts) ? def.fonts.map((f) => f?.file) : []),
      def.logo?.mark,
      def.logo?.favicon,
    ]
      .filter((p): p is string => typeof p === "string")
      .map(packagePath);
    const type = ASSET_TYPES.find(([re]) => re.test(file))?.[1];
    if (
      v.objectPrefix === null ||
      type === undefined ||
      !isThemeAssetPath(file) ||
      !named.includes(file)
    ) {
      throw notFound(`Theme asset ${file}`);
    }
    this.storage.assertAvailable();
    const got = await this.storage.deployment().get(`${v.objectPrefix}${file}`);
    if (!got) {
      this.log.warn("theme asset missing from object storage", { themeId: id, version, file });
      throw notFound(`Theme asset ${file}`);
    }
    return { contentType: type, data: new Uint8Array(await new Response(got.body).arrayBuffer()) };
  }
}
