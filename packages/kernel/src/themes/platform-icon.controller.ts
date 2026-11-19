import { Controller, Delete, Get, HttpCode, Inject, Put } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal, type Principal, SuperAdmin } from "../identity/principal.js";
import { writeActorOf } from "../identity/write-actor.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import {
  PlatformIconBody,
  PlatformIconParams,
  type PlatformIconView,
} from "./platform-icon.schemas.js";
import { PlatformIconService } from "./platform-icon.service.js";

class PlatformIconParamsDto extends createZodDto(PlatformIconParams, "PlatformIconParams") {}
class PlatformIconBodyDto extends createZodDto(PlatformIconBody, "PlatformIconBody") {}

/**
 * The platform icon setting (`/api/v1/admin/platform/icons*`, mobile layout spec §10.2.1): the
 * app icon, its maskable variant and the SVG favicon the PWA manifest, the favicons and native
 * clients use. Super admins only (one installed app per deployment); service tokens 403. The
 * upload is JSON base64 so the Platform tool mirrors it (`admin.set-icon`).
 */
@Controller("api/v1/admin/platform/icons")
@SuperAdmin()
export class PlatformIconController {
  constructor(@Inject(PlatformIconService) private readonly icons: PlatformIconService) {}

  /** `{ icons }`: every uploaded icon with its public URL; a purpose not listed uses the default. */
  @Get()
  list(): Promise<{ icons: PlatformIconView[] }> {
    return this.icons.list();
  }

  /** Uploads the icon of a purpose (PNG 512 × 512 for app / maskable, SVG for favicon, ≤ 1 MiB). */
  @Put(":purpose")
  set(
    @CurrentPrincipal() principal: Principal,
    @ZParam(PlatformIconParamsDto) { purpose }: z.infer<typeof PlatformIconParams>,
    @ZBody(PlatformIconBodyDto) body: z.infer<typeof PlatformIconBody>,
  ): Promise<PlatformIconView> {
    return this.icons.set(purpose, body.contentType, body.dataBase64, writeActorOf(principal));
  }

  /** Restores the built-in icon of a purpose; 204 also when none was uploaded. */
  @Delete(":purpose")
  @HttpCode(204)
  async clear(
    @CurrentPrincipal() principal: Principal,
    @ZParam(PlatformIconParamsDto) { purpose }: z.infer<typeof PlatformIconParams>,
  ): Promise<void> {
    await this.icons.clear(purpose, writeActorOf(principal));
  }
}
