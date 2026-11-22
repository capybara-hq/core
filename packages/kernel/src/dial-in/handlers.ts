import type { DialInHandler } from "@capybara-hq/plugin-sdk";
import { DEVICE_DIAL_IN_PROTOCOL } from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import { DeviceProviderSelection } from "../devices/device-provider-selection.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { DeviceProviders, isInternalProvider } from "../sandbox/providers.js";

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
    private readonly selection: Pick<DeviceProviderSelection, "isOnInOrg">,
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
    const internal = isInternalProvider(plugin);
    const protocol = internal
      ? DEVICE_DIAL_IN_PROTOCOL
      : this.registry.current(plugin)?.manifest.permissions?.dialIn?.protocol;
    const handler = entry.impl.dialIn;
    if (protocol === undefined || handler === undefined) return { unavailable: "not-dial-in" };
    if (!(await this.selection.isOnInOrg(row.org_id, plugin))) return { unavailable: "off" };
    if (internal) {
      if ((handler as Partial<KernelDialInHandler>).kernelInternal !== true)
        return { unavailable: "not-dial-in" };
      return { plugin, protocol, internal, handler: handler as KernelDialInHandler };
    }
    return { plugin, protocol, internal, handler };
  }
}
