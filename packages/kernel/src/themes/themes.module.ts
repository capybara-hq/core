import { Module } from "@nestjs/common";
import { SuperAdminLockModule } from "../identity/super-admin.js";
import { StorageModule } from "../storage/storage.module.js";
import { PlatformIconService } from "./platform-icon.service.js";
import { ThemeDeliveryService } from "./theme-delivery.service.js";
import { ThemesService } from "./themes.service.js";

/**
 * Themes (themes spec §7-§9): resolution, the org's theme listing and delivery; and the platform
 * icon setting (mobile layout spec §10.2.1).
 */
@Module({
  imports: [StorageModule, SuperAdminLockModule],
  providers: [ThemesService, ThemeDeliveryService, PlatformIconService],
  exports: [ThemesService, ThemeDeliveryService, PlatformIconService],
})
export class ThemesModule {}
