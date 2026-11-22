import type { DeviceProvider } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ExtensionPointDefaults } from "../extensions/point-defaults.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgSettingsService } from "../orgs/settings.service.js";
import { type DeviceProviderEntry, DeviceProviders } from "../sandbox/providers.js";
import { readPlatformDefaultProvider } from "./default-provider-setting.js";

/**
 * Which device providers serve an org: the loaded `device-provider@1` extensions switched on in it
 * (valid config), and the provider a new device gets by default. Everything is read at every call
 * (PG; no in-process cache). In-process providers (`DeviceProviders.register`) are never listed.
 */
@Injectable()
export class DeviceProviderSelection {
  constructor(
    @Inject(DeviceProviders)
    private readonly providers: Pick<DeviceProviders, "forDevice" | "registered">,
    @Inject(ExtensionPointDefaults)
    private readonly points: Pick<ExtensionPointDefaults, "providersFor" | "serves">,
    @Inject(OrgSettingsService) private readonly orgSettings: Pick<OrgSettingsService, "get">,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(KernelDb) private readonly kdb: Pick<KernelDb, "db">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** The providers that serve `orgId` now, in extension-name order. */
  async onInOrg(orgId: string): Promise<DeviceProviderEntry[]> {
    const { providers } = await this.points.providersFor<DeviceProvider>(orgId, "device-provider");
    const out: DeviceProviderEntry[] = [];
    for (const p of providers) {
      const e = this.providers.forDevice(p.extension);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Whether the provider `plugin` (a device's `devices.provider`) serves `orgId` now: an extension
   * that {@link onInOrg} lists; an in-process provider is no catalog item and has no org switch,
   * so for it "on in the org" means registered in this process. Evaluates only that provider
   * ({@link ExtensionPointDefaults.serves}, the criteria {@link onInOrg} applies).
   */
  async isOnInOrg(orgId: string, plugin: string): Promise<boolean> {
    if (this.providers.registered(plugin)) return true;
    if (this.providers.forDevice(plugin) === undefined) return false;
    return this.points.serves(orgId, "device-provider", plugin);
  }

  /**
   * The provider a new device of `orgId` gets: the org's `deviceDefaultProvider`, else the
   * platform's `devices.defaultProvider`, returned only while it serves the org (the setting is
   * validated at write time and can go stale: unknown, unloaded or off in the org is none, never
   * another provider).
   */
  async defaultFor(orgId: string): Promise<DeviceProviderEntry | undefined> {
    const name =
      (await this.orgSettings.get(orgId)).deviceDefaultProvider ??
      (await readPlatformDefaultProvider(this.config, this.kdb.db, this.log)).provider;
    if (name === null || name === undefined) return undefined;
    return (await this.onInOrg(orgId)).find((e) => e.plugin === name);
  }
}
