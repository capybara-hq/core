import type { DialInHandler } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { DeviceProviderSelection } from "../devices/device-provider-selection.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { type DeviceProviderEntry, DeviceProviders } from "../sandbox/providers.js";

/** The provider serving a device over the dial-in channel, and the protocol its machines speak. */
export interface DialInServing {
  plugin: string;
  protocol: string;
  handler: DialInHandler;
}

/**
 * Why a device has no dial-in handler: its provider declares no `permissions.dialIn` (or the
 * device has none), is off in the device's org, or is not loaded in this process.
 */
export interface DialInUnavailable {
  unavailable: "not-dial-in" | "off" | "unloaded";
}

/**
 * The dial-in handlers of devices: the device's provider (`devices.provider`), the protocol its
 * manifest declares (`permissions.dialIn.protocol`) and its `DeviceProvider.dialIn`, served only
 * while the provider is on in the device's org ({@link DeviceProviderSelection.isOnInOrg}). Read
 * at every call (PG and the process's extension registry; nothing cached).
 */
@Injectable()
export class DialInHandlers {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(DeviceProviders)
    private readonly providers: Pick<DeviceProviders, "forDevice" | "loaded">,
    @Inject(DeviceProviderSelection)
    private readonly selection: Pick<DeviceProviderSelection, "isOnInOrg" | "onInOrg">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "current">,
  ) {}

  // org-filter: deviceId is the device of an authenticated machine connection (the gateway); the
  // device row supplies its org
  async forDevice(deviceId: string): Promise<DialInServing | DialInUnavailable> {
    const row = await this.kdb.db
      .selectFrom("devices")
      .select(["org_id", "provider"])
      .where("id", "=", deviceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row || row.provider === null) return { unavailable: "not-dial-in" };
    const plugin = row.provider;
    const entry = this.providers.forDevice(plugin);
    if (!entry) return { unavailable: "unloaded" };
    const protocol = this.protocolOf(entry);
    if (protocol === undefined) return { unavailable: "not-dial-in" };
    if (!(await this.selection.isOnInOrg(row.org_id, plugin))) return { unavailable: "off" };
    return { plugin, protocol, handler: entry.impl.dialIn as DialInHandler };
  }

  /**
   * The dial-in providers that serve `orgId` now, each with the protocol its machines speak: the
   * extensions {@link DeviceProviderSelection.onInOrg} lists that declare `permissions.dialIn` and
   * implement `DeviceProvider.dialIn`, in extension-name order. Read at every call.
   */
  async onInOrg(orgId: string): Promise<{ plugin: string; protocol: string }[]> {
    const out: { plugin: string; protocol: string }[] = [];
    for (const e of await this.selection.onInOrg(orgId)) {
      const protocol = this.protocolOf(e);
      if (protocol !== undefined) out.push({ plugin: e.plugin, protocol });
    }
    return out;
  }

  /**
   * The dial-in providers loaded in this process, in any org or none, each with the protocol its
   * machines speak (registry order). Read at every call; `GET /api/v1/meta` reports from it
   * whether machines running `capybara-device` can connect at all.
   */
  loaded(): { plugin: string; protocol: string }[] {
    const out: { plugin: string; protocol: string }[] = [];
    for (const e of this.providers.loaded()) {
      const protocol = this.protocolOf(e);
      if (protocol !== undefined) out.push({ plugin: e.plugin, protocol });
    }
    return out;
  }

  /**
   * The protocol a provider's machines speak, when it serves devices over the dial-in channel:
   * its manifest's `permissions.dialIn.protocol` and a `DeviceProvider.dialIn` handler (an
   * in-process provider has no manifest, so none). Undefined otherwise.
   */
  private protocolOf(entry: DeviceProviderEntry): string | undefined {
    if (entry.impl.dialIn === undefined) return undefined;
    return this.registry.current(entry.plugin)?.manifest.permissions?.dialIn?.protocol;
  }
}
