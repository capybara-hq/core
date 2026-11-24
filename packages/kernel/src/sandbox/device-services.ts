import {
  DEVICE_SERVICE_NAME_RE,
  DeviceAccessError,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type DeviceServiceMethods, SandboxService } from "./sandbox.service.js";
import type { SandboxUseContext } from "./use-context.js";

/**
 * Device services (browser use spec §5): one long-lived named process per device, started on an
 * extension's behalf in the device's own sandbox with its own state directory, reached by
 * request over its socket. Starting and requesting are uses of the device like any tool call
 * ({@link SandboxService.withDeviceServices}: a suspended instance is resumed); stopping never
 * starts or resumes one. A provider without the service methods is refused with
 * `DeviceAccessError("capability_missing")` before the device is touched. The command review of a
 * launch and the extension's permission are the caller's (`ctx.deviceAccess`).
 */
@Injectable()
export class DeviceServices {
  constructor(@Inject(SandboxService) private readonly sandbox: SandboxService) {}

  /** Starts the service in the device, or finds it running (the provider keeps a running one). */
  async ensure(
    use: SandboxUseContext,
    spec: DeviceServiceSpec,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus> {
    assertServiceName(spec.name);
    return this.sandbox.withDeviceServices(
      use,
      requireServices,
      (h, p, sig) => (p.ensureService as NonNullable<typeof p.ensureService>)(h, spec, sig),
      signal,
    );
  }

  /** One request to the service's socket; resolves its answer (throws when it is not running). */
  async request(
    use: SandboxUseContext,
    name: string,
    body: Uint8Array,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    assertServiceName(name);
    return this.sandbox.withDeviceServices(
      use,
      requireServices,
      (h, p, sig) =>
        (p.serviceRequest as NonNullable<typeof p.serviceRequest>)(h, name, body, {
          timeoutMs,
          signal: sig,
        }),
      signal,
    );
  }

  /**
   * Stops the service when the device's instance runs; nothing to do otherwise (a suspended or
   * destroyed instance has no running service, and stopping never resumes it).
   */
  async stop(use: SandboxUseContext, name: string, signal: AbortSignal): Promise<void> {
    assertServiceName(name);
    const current = await this.sandbox.currentInstance(use.deviceId);
    if (!current) return;
    await this.sandbox.ifRunning(
      use.deviceId,
      { createdAt: current.createdAt },
      async (p, h, sig) => {
        requireServices(p);
        await (p.stopService as NonNullable<typeof p.stopService>)(h, name, sig);
      },
      signal,
    );
  }
}

function assertServiceName(name: string): void {
  if (!DEVICE_SERVICE_NAME_RE.test(name))
    throw new Error(
      `Invalid device service name ${JSON.stringify(name)}: use 1 to 32 characters, a lower-case letter then lower-case letters, digits and "-".`,
    );
}

/** Refuses a provider that lacks any of the methods a service needs (`openStream` is optional). */
function requireServices(p: DeviceServiceMethods): void {
  if (!p.ensureService || !p.stopService || !p.serviceRequest)
    throw new DeviceAccessError(
      "capability_missing",
      "This device's provider cannot run device services; choose a device on a provider that supports them.",
    );
}
