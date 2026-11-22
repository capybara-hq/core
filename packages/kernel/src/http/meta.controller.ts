import {
  DEVICE_DIAL_IN_PROTOCOL,
  DEVICE_PROTOCOL_VERSION,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { Controller, Get, Header, Inject } from "@nestjs/common";
import { z } from "zod";
import { DialInHandlers } from "../dial-in/handlers.js";
import { Public } from "../identity/principal.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { PushProviderHost } from "../push/provider-host.js";
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
    /**
     * The `capybara-device` protocol majors the loaded dial-in providers speak (their
     * `permissions.dialIn.protocol`); without any, the SDK's major, and `localDevices` is false.
     */
    device: z.object({ min: z.number().int(), max: z.number().int() }),
  }),
  features: z.object({
    /** A dial-in provider speaking `capybara-device/<major>` (device-local) is loaded. */
    localDevices: z.boolean(),
    appSignIn: z.boolean(),
    /** App ids a push provider covers with the providers that do; `[]` without `http.publicUrl`. */
    push: z.array(z.object({ appId: z.string(), providers: z.array(z.string()) })),
  }),
  /** The redirect URIs app sign-in accepts (`auth.appRedirectUris`); [] while appSignIn is off. */
  appRedirectUris: z.array(z.string()),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

/** The protocol name `capybara-device` speaks (`capybara-device` of `capybara-device/<major>`). */
const DEVICE_PROTOCOL_NAME = DEVICE_DIAL_IN_PROTOCOL.slice(0, DEVICE_DIAL_IN_PROTOCOL.indexOf("/"));

/**
 * The `capybara-device` majors the given dial-in protocols name (`<name>/<major>`, already checked
 * against `DIAL_IN_PROTOCOL_RE` when the provider loaded), as a range; null when none does.
 */
export function deviceProtocolRange(
  protocols: readonly string[],
): { min: number; max: number } | null {
  const majors = protocols
    .map((p) => p.split("/"))
    .filter(([name]) => name === DEVICE_PROTOCOL_NAME)
    .map(([, major]) => Number(major))
    .filter((n) => Number.isInteger(n));
  if (majors.length === 0) return null;
  return { min: Math.min(...majors), max: Math.max(...majors) };
}

/** `GET /api/v1/meta`: public, never cached, reveals only what a client needs before signing in. */
@Controller("api/v1/meta")
export class MetaController {
  constructor(
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PlatformIconService) private readonly icons: PlatformIconService,
    @Inject(PushProviderHost) private readonly push: PushProviderHost,
    @Inject(DialInHandlers) private readonly dialIn: Pick<DialInHandlers, "loaded">,
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
    const appSignIn = Boolean(config.http.publicUrl);
    // Local devices exist only while a dial-in provider speaking capybara-device is loaded
    // (device-local); the shells offer "connect this machine" only then.
    const devices = deviceProtocolRange(this.dialIn.loaded().map((p) => p.protocol));
    return {
      name: config.platform.name ?? null,
      icon: app,
      icons: { app, maskable, favicon },
      protocols: {
        device: devices ?? { min: DEVICE_PROTOCOL_VERSION, max: DEVICE_PROTOCOL_VERSION },
      },
      features: {
        localDevices: devices !== null,
        // The authorize route answers app_auth.unavailable without http.publicUrl.
        appSignIn,
        // A push message carries the deployment origin, which needs http.publicUrl.
        push: config.http.publicUrl ? this.push.coverage() : [],
      },
      // Not secret: an app that finds its own URI missing says so before opening the browser.
      appRedirectUris: appSignIn ? [...config.auth.appRedirectUris] : [],
    };
  }

  /** A customised platform icon's versioned URL (the one the manifest uses); null for the default. */
  private async iconUrl(purpose: PlatformIconPurpose): Promise<string | null> {
    return (await this.icons.current(purpose))?.url ?? null;
  }
}
