import type { DialInHandler } from "@capybara-hq/plugin-sdk";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import { DeviceProviderSelection } from "../devices/device-provider-selection.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  type DeviceProviderEntry,
  DeviceProviders,
  isInternalProvider,
  LOCAL_PROVIDER,
} from "../sandbox/providers.js";

/** The authenticated connection a kernel-internal handler is told about (never an extension). */
export interface DialInConnectionFacts {
  machineId: string;
  connectionId: string;
}

/**
 * A kernel-internal provider's dial-in handler (`@local`, interim): the gateway passes it the
 * authenticated connection as a last argument. An extension's handler never gets it.
 */
export interface KernelDialInHandler extends DialInHandler {
  readonly kernelInternal: true;
  onHello(
    deviceId: string,
    hello: unknown,
    signal: AbortSignal,
    connection?: DialInConnectionFacts,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  onFrame?(deviceId: string, frame: unknown, connection?: DialInConnectionFacts): Promise<void>;
}

/** The provider serving a device over the dial-in channel, and the protocol its machines speak. */
export type DialInServing = {
  plugin: string;
  protocol: string;
} & (
  | { internal: false; handler: DialInHandler }
  /** A kernel-internal provider: its handler gets the authenticated connection. */
  | { internal: true; handler: KernelDialInHandler }
);

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
 *
 * The kernel's own `@local` provider (interim, until the `device-local` plugin) speaks the
 * protocol {@link DEVICE_DIAL_IN_PROTOCOL} through the handler it registers.
 */
@Injectable()
export class DialInHandlers {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(DeviceProviders) private readonly providers: Pick<DeviceProviders, "forDevice">,
    @Inject(DeviceProviderSelection)
    private readonly selection: Pick<DeviceProviderSelection, "isOnInOrg" | "onInOrg">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "current">,
  ) {}

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
    const handler = entry.impl.dialIn as DialInHandler;
    if (isInternalProvider(plugin)) {
      return { plugin, protocol, internal: true, handler: handler as KernelDialInHandler };
    }
    return { plugin, protocol, internal: false, handler };
  }

  /**
   * The dial-in providers that serve `orgId` now, each with the protocol its machines speak: the
   * extensions {@link DeviceProviderSelection.onInOrg} lists that declare `permissions.dialIn` and
   * implement `DeviceProvider.dialIn`, in extension-name order, then the kernel's own `@local`
   * while it is registered (interim, until the `device-local` plugin). Read at every call.
   */
  async onInOrg(orgId: string): Promise<{ plugin: string; protocol: string }[]> {
    const out: { plugin: string; protocol: string }[] = [];
    const entries = [...(await this.selection.onInOrg(orgId))];
    const local = this.providers.forDevice(LOCAL_PROVIDER);
    if (local) entries.push(local);
    for (const e of entries) {
      const protocol = this.protocolOf(e);
      if (protocol !== undefined) out.push({ plugin: e.plugin, protocol });
    }
    return out;
  }

  /**
   * The protocol a provider's machines speak, when it serves devices over the dial-in channel:
   * its manifest's `permissions.dialIn.protocol` (the internal `@local`:
   * {@link DEVICE_DIAL_IN_PROTOCOL}) and a `DeviceProvider.dialIn` handler (an internal one
   * marked kernel-internal). Undefined otherwise.
   */
  private protocolOf(entry: DeviceProviderEntry): string | undefined {
    const handler = entry.impl.dialIn;
    if (handler === undefined) return undefined;
    if (isInternalProvider(entry.plugin)) {
      return (handler as Partial<KernelDialInHandler>).kernelInternal === true
        ? DEVICE_DIAL_IN_PROTOCOL
        : undefined;
    }
    return this.registry.current(entry.plugin)?.manifest.permissions?.dialIn?.protocol;
  }
}
