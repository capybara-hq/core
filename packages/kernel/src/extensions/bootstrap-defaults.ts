import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { SettingsService } from "../identity/settings.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The deployment defaults of the extra bootstrap manifest (bootstrap extra manifest spec §7),
 * applied at every kernel start after the extensions loaded (and the bootstrap step's second pass),
 * whether or not the step ran in that start: cheap, and a no-op once applied or once a super admin
 * chose, so a default that could not be applied yet (its theme not imported, not eligible) is
 * retried at the next start. Never fails the start.
 */
@Injectable()
export class BootstrapDefaultsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn" | "error">,
  ) {}

  /**
   * `defaultTheme`: the platform default theme, `(plugin, theme)` resolved to the live
   * platform-owned `platform_themes` row and handed to {@link SettingsService.applyBootstrapUiTheme}.
   */
  async apply(defaultTheme?: { plugin: string; theme: string }): Promise<void> {
    if (defaultTheme === undefined) return;
    const fields = { plugin: defaultTheme.plugin, theme: defaultTheme.theme };
    try {
      const row = await this.db
        .selectFrom("platform_themes")
        .select("id")
        .where("plugin_name", "=", defaultTheme.plugin)
        .where("name", "=", defaultTheme.theme)
        .where("deleted_at", "is", null)
        .where("owner_org_id", "is", null)
        .executeTakeFirst();
      if (row === undefined) {
        this.log.warn(
          "bootstrap: the default theme is not installed; retried on the next start",
          fields,
        );
        return;
      }
      const outcome = await this.settings.applyBootstrapUiTheme(row.id);
      if (outcome === "applied") {
        this.log.info("bootstrap: the default theme is the platform default", fields);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "theme.not_available") {
        this.log.warn(
          "bootstrap: the default theme cannot be the platform default; retried on the next start",
          { ...fields, error: e.message },
        );
        return;
      }
      this.log.error(
        "bootstrap: the default theme could not be applied; retried on the next start",
        {
          ...fields,
          error: errMsg(e),
        },
      );
    }
  }
}
