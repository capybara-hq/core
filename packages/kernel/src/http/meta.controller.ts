import { DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../identity/principal.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";

/** Pre-sign-in discovery document native clients and the PWA manifest read. */
export const MetaResponseSchema = z.object({
  name: z.string().nullable(),
  icon: z.string().nullable(),
  protocols: z.object({
    device: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
  features: z.object({ localDevices: z.boolean(), appSignIn: z.boolean() }),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

/** `GET /api/v1/meta`: public, never cached, reveals only what a client needs before signing in. */
@Controller("api/v1/meta")
export class MetaController {
  constructor(@Inject(KernelConfigService) private readonly config: KernelConfigService) {}

  @Public()
  @Get()
  @Header("cache-control", "no-store")
  async meta(): Promise<MetaResponse> {
    return {
      name: this.config.get().platform.name ?? null,
      icon: await this.iconUrl(),
      protocols: { device: { min: DEVICE_PROTOCOL_VERSION, max: DEVICE_PROTOCOL_VERSION } },
      features: { localDevices: true, appSignIn: true },
    };
  }

  /** The platform icon's URL; none is served yet. */
  private async iconUrl(): Promise<string | null> {
    return null;
  }
}
