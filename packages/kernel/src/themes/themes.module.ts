import { Module } from "@nestjs/common";
import { ThemesService } from "./themes.service.js";

/** Themes (themes spec §7-§9): resolution and the org's theme listing. */
@Module({ providers: [ThemesService], exports: [ThemesService] })
export class ThemesModule {}
