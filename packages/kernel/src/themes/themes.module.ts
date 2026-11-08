import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import { ThemeDeliveryService } from "./theme-delivery.service.js";
import { ThemesService } from "./themes.service.js";

/** Themes (themes spec §7-§9): resolution, the org's theme listing and delivery. */
@Module({
  imports: [StorageModule],
  providers: [ThemesService, ThemeDeliveryService],
  exports: [ThemesService, ThemeDeliveryService],
})
export class ThemesModule {}
