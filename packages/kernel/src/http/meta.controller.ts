import { DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../identity/principal.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import type { PlatformIconPurpose } from "../themes/platform-icon.schemas.js";
import { PlatformIconService } from "../themes/platform-icon.service.js";

/** Pre-sign-in discovery document native clients and the PWA manifest read. */
export const MetaResponseSchema = z.object({
  name: z.string().nullable(),
  icon: z.string().nullable(),
  icons: z.object({
    app: z.string().nullable(),
    maskable: z.string().nullable(),
    favicon: z.string().nullable(),
  }),
  protocols: z.object({
    device: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
  features: z.object({ localDevices: z.boolean(), appSignIn: z.boolean() }),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

/** `GET /api/v1/meta`: public, never cached, reveals only what a client needs before signing in. */
@Controller("api/v1/meta")
export class MetaController {
  constructor(
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PlatformIconService) private readonly icons: PlatformIconService,
  ) {}

  @Public()
  @Get()
  @Header("cache-control", "no-store")
  async meta(): Promise<MetaResponse> {
    const config = this.config.get();
    const [app, maskable, favicon] = await Promise.all([
      this.iconUrl("app"),
      this.iconUrl("maskable"),
      this.iconUrl("favicon"),
    ]);
    return {
      name: config.platform.name ?? null,
      icon: app,
      icons: { app, maskable, favicon },
      protocols: { device: { min: DEVICE_PROTOCOL_VERSION, max: DEVICE_PROTOCOL_VERSION } },
      features: {
        localDevices: true,
        // The authorize route answers app_auth.unavailable without http.publicUrl.
        appSignIn: Boolean(config.http.publicUrl),
      },
    };
  }

  /** A customised platform icon's versioned URL (the one the manifest uses); null for the default. */
  private async iconUrl(purpose: PlatformIconPurpose): Promise<string | null> {
    return (await this.icons.current(purpose))?.url ?? null;
  }
}
