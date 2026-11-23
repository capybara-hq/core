import { DEVICE_PROVIDER_EXTENSION_POINT, type DeviceProvider } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ExtensionRegistry } from "../extensions/registry.js";
import { guardProviderConnection } from "./unreachable.js";

/**
 * An in-process provider name: it starts with `@`, which no extension name can
 * (`EXTENSION_NAME_RE`), so it never collides with a loaded `device-provider@1` plugin.
 */
export const isInProcessName = (name: string): boolean => name.startsWith("@");

/**
 * Whether a provider serves its devices over the dial-in channel: it implements
 * `DeviceProvider.dialIn` (an extension may only when it declares `permissions.dialIn`, checked
 * when it provides the point). Its devices are online while a gateway replica holds their machine's
 * connection (`DialInRelay.online`).
 */
export const servesDialIn = (entry: Pick<DeviceProviderEntry, "impl">): boolean =>
  entry.impl.dialIn !== undefined;

/** A device provider: its name (plugin name, or an in-process `@…` name) and implementation. */
export interface DeviceProviderEntry {
  plugin: string;
  /** The loaded extension's version; an in-process provider reports its own. */
  version: string;
  impl: DeviceProvider;
}

/**
 * The device providers of this process (a registry: which of them serve an org is
 * `DeviceProviderSelection`). A provider is a loaded `device-provider@1` extension, read from the
 * {@link ExtensionRegistry} at every call (providers are ready only after the extension load, and
 * change with installs). An in-process provider (an `@…` name, {@link register}) is code
 * registered in every replica, never shared state; the kernel ships none (tests register stubs).
 *
 * Every `device-provider@1` extension is handed out guarded: a network-level failure to reach it is
 * rethrown as `SandboxProviderUnreachableError` (`./unreachable.ts`), so the tools can tell it
 * apart. In-process providers are not.
 */
@Injectable()
export class DeviceProviders {
  private readonly inProcess = new Map<string, DeviceProviderEntry>();

  constructor(
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
  ) {}

  /** Registers an in-process provider (an `@…` name); a later registration replaces it. */
  register(entry: DeviceProviderEntry): void {
    if (!isInProcessName(entry.plugin)) {
      throw new Error(`an in-process device provider name starts with @: ${entry.plugin}`);
    }
    this.inProcess.set(entry.plugin, entry);
  }

  /**
   * Whether `plugin` names a registered in-process provider: no catalog item and no org switch,
   * so it serves every org of this process (`DeviceProviderSelection.isOnInOrg`).
   */
  registered(plugin: string): boolean {
    return this.inProcess.has(plugin);
  }

  /**
   * The provider of a device, from its `devices.provider` (fixed at creation): a registered
   * in-process one, else the loaded `device-provider@1` extension of that plugin name,
   * on in no org in particular (whether it serves the device's org is
   * `DeviceProviderSelection.isOnInOrg`). Undefined when neither exists, or for a device without
   * a provider (`null`). Never another provider in its place.
   */
  forDevice(provider: string | null): DeviceProviderEntry | undefined {
    if (provider === null) return undefined;
    const own = this.inProcess.get(provider);
    if (own) return own;
    const e = this.registry
      .list("device-provider")
      .find((x) => x.capability === DEVICE_PROVIDER_EXTENSION_POINT && x.plugin === provider);
    return e ? this.guarded(e) : undefined;
  }

  /** Every loaded `device-provider@1` extension (no in-process ones), in registry order. */
  loaded(): DeviceProviderEntry[] {
    return this.registry
      .list("device-provider")
      .filter((x) => x.capability === DEVICE_PROVIDER_EXTENSION_POINT)
      .map((e) => this.guarded(e));
  }

  /**
   * Every provider of this process: the loaded `device-provider@1` extensions in registry order,
   * then the registered in-process ones (the sweeps go over each provider's own rows).
   */
  all(): DeviceProviderEntry[] {
    return [...this.loaded(), ...this.inProcess.values()];
  }

  private guarded(e: { plugin: string; version: string; impl: unknown }): DeviceProviderEntry {
    return {
      plugin: e.plugin,
      version: e.version,
      impl: guardProviderConnection(e.impl as DeviceProvider),
    };
  }
}
